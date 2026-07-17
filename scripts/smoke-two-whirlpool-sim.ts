/**
 * READ-ONLY smoke check: proves the two-whirlpool arb transaction is
 * well-formed and SIMULATES on real mainnet state as the surrogate owner
 * (sigVerify:false), and that nothing is ever sent. Forces a realistic
 * opportunity through detect() with a negative threshold (this is a
 * build+simulate check, not a profit claim) so the executor's simulation
 * path is exercised even though the live market shows no profitable gap
 * between two deep Orca pools.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";
import { detect } from "../src/detect.js";
import { buildTwoWhirlpoolArbTransaction } from "../src/txbuilder/twoWhirlpool.js";
import type { PoolSnapshot } from "../src/types.js";

const POOL_A = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const POOL_B = "FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q";
const SURROGATE = "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa";
const ORCA_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const pools = JSON.parse(readFileSync("data/pools.mainnet.json", "utf8")) as {
    quoteMint: string;
  };
  const pair = {
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: pools.quoteMint,
    baseDecimals: 9,
    quoteDecimals: 6,
  };
  const a = new PublicKey(POOL_A);
  const b = new PublicKey(POOL_B);
  const [accA, accB] = await connection.getMultipleAccountsInfo([a, b]);
  if (!accA || !accB) throw new Error("pool accounts missing");
  const stateA = decodeWhirlpool(accA.data);
  const stateB = decodeWhirlpool(accB.data);

  const snap = (addr: string, s: typeof stateA): PoolSnapshot => ({
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: addr,
    pair,
    fetchedAtMs: Date.now(),
    slot: 0,
    source: "smoke",
    sqrtPriceX64: s.sqrtPriceX64,
    liquidity: s.liquidity,
    tickCurrentIndex: s.tickCurrentIndex,
    feeBps: s.feeBps,
  });

  // Negative threshold => detect returns realistic leg amounts even though
  // the trade is not profitable (build+simulate smoke, not a trade claim).
  const decision = detect(snap(POOL_A, stateA), snap(POOL_B, stateB), {
    tradeSizeQuote: 100_000_000n, // 100 USDC
    minProfitThresholdQuote: -50_000_000n, // allow up to -50 USDC
    slippageToleranceBps: 150, // headroom so the spot estimate clears real impact
    estTxFeeQuote: 0n,
  });
  if (decision.decision !== "opportunity") {
    throw new Error(`expected a (forced) opportunity, got ${decision.decision}`);
  }
  console.log(
    `[smoke] forced opportunity: buy ${decision.direction.buyPoolAddress} ` +
      `sell ${decision.direction.sellPoolAddress}, quoteIn=${decision.quoteIn} ` +
      `baseOut=${decision.baseOut} quoteOut=${decision.quoteOut} ` +
      `(net ${decision.estNetProfit}, threshold ${decision.minProfitThreshold})`,
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const programId = new PublicKey(ORCA_PROGRAM);
  const tx = buildTwoWhirlpoolArbTransaction(
    {
      payer: new PublicKey(SURROGATE),
      recentBlockhash: blockhash,
      pair,
      whirlpoolA: { programId, poolAddress: a, state: stateA, tickCurrentIndex: stateA.tickCurrentIndex },
      whirlpoolB: { programId, poolAddress: b, state: stateB, tickCurrentIndex: stateB.tickCurrentIndex },
    },
    decision,
  );

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  console.log(`[smoke] simulate err: ${JSON.stringify(sim.value.err)}`);
  console.log(`[smoke] unitsConsumed: ${sim.value.unitsConsumed ?? "n/a"}`);
  console.log(`[smoke] logs tail:`);
  for (const l of (sim.value.logs ?? []).slice(-12)) console.log(`   ${l}`);
  console.log("[smoke] NOTE: only simulateTransaction was called — nothing was sent.");
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
