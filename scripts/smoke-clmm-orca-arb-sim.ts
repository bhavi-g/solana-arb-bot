/**
 * READ-ONLY smoke check: proves buildClmmOrcaArbTransaction produces a
 * well-formed ATOMIC two-leg (CLMM + Orca) tx that SIMULATES against real
 * mainnet state for BOTH direction assignments (sigVerify:false, surrogate
 * owner). The live-verification leg the design spec requires. Only
 * simulateTransaction is ever called; nothing is sent.
 *
 * Pass: for both directions, both program IDs appear in the sim logs AND
 * err is null OR a slippage/amount-class error (a well-formed tx whose
 * round-trip simply wasn't profitable). A malformed-account/PDA error
 * (a leg never reached its program) is the only FAIL.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "../src/decode/clmm.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "../src/txbuilder/clmmOrca.js";
import type { Opportunity } from "../src/types.js";

const CLMM_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SURROGATE = "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Well-formed if both legs reached their programs; err null OR slippage. */
function acceptable(err: unknown, logs: string[]): boolean {
  const hitBoth =
    logs.some((l) => l.includes(CLMM_PROGRAM)) &&
    logs.some((l) => l.includes(ORCA_PROGRAM));
  if (!hitBoth) return false; // a leg never executed → malformed
  if (err === null) return true; // a real gap cleared
  // Slippage/amount-class errors = well-formed tx, unprofitable round-trip.
  return /Custom|amount|Slippage|TooLittle|MinimumOut|0x1771/i.test(JSON.stringify(err));
}

async function main(): Promise<void> {
  const orcaPoolEnv = process.env.ORCA_POOL_ADDRESS;
  if (!orcaPoolEnv) throw new Error("set ORCA_POOL_ADDRESS (a SOL/USDC Orca whirlpool)");
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const clmmProgramId = new PublicKey(CLMM_PROGRAM);
  const orcaProgramId = new PublicKey(ORCA_PROGRAM);
  const clmmPool = new PublicKey(CLMM_POOL);
  const orcaPool = new PublicKey(orcaPoolEnv);
  const surrogate = new PublicKey(SURROGATE);

  const [clmmAcc, orcaAcc] = await connection.getMultipleAccountsInfo([clmmPool, orcaPool]);
  if (!clmmAcc || !orcaAcc) throw new Error("CLMM pool or Orca whirlpool not found");
  const clmmState = decodeClmmPool(clmmAcc.data);
  const orcaState = decodeWhirlpool(orcaAcc.data);

  if (clmmState.tokenMint0.toBase58() !== SOL_MINT) {
    throw new Error(
      `expected orientation NORMAL (SOL=mint0), got mint0=${clmmState.tokenMint0.toBase58()}`,
    );
  }

  const ammConfigAcc = await connection.getAccountInfo(clmmState.ammConfig);
  if (!ammConfigAcc) throw new Error("CLMM AmmConfig not found");
  const clmmFeeBps = decodeClmmAmmConfigFeeBps(ammConfigAcc.data);
  console.log(`[smoke] CLMM fee ${clmmFeeBps}bps; Orca fee ${orcaState.feeBps}bps`);

  const pair = {
    baseMint: SOL_MINT,
    quoteMint: USDC_MINT,
    baseDecimals: 9,
    quoteDecimals: 6,
  };
  const ctx = (blockhash: string): ClmmOrcaBuildContext => ({
    payer: surrogate, // PublicKey → unsigned build
    recentBlockhash: blockhash,
    pair,
    clmm: { programId: clmmProgramId, poolAddress: clmmPool, state: clmmState, tickCurrentIndex: clmmState.tickCurrentIndex },
    whirlpool: { programId: orcaProgramId, poolAddress: orcaPool, state: orcaState, tickCurrentIndex: orcaState.tickCurrentIndex },
  });

  // 100 USDC in, buy-leg min-out relaxed to 1 lamport-SOL (buy leg never
  // gates the shape check); the sell leg's min-out is quoteIn+0 per the
  // builder — see the pass criterion above for why err may be a slippage
  // error rather than null.
  const inputUsdc = 100_000_000n; // 100 USDC
  const opp = (buyOn: "raydium-clmm" | "orca-whirlpool"): Opportunity => ({
    decision: "opportunity",
    direction: {
      buyOn,
      sellOn: buyOn === "raydium-clmm" ? "orca-whirlpool" : "raydium-clmm",
    },
    gapBps: 0,
    quoteIn: inputUsdc,
    baseOut: 1n, // buy-leg min-out (relaxed)
    quoteOut: inputUsdc,
    estNetProfit: 0n,
    minProfitThreshold: 0n,
  });

  let allOk = true;
  for (const buyOn of ["raydium-clmm", "orca-whirlpool"] as const) {
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = buildClmmOrcaArbTransaction(ctx(blockhash), opp(buyOn));
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    const logs = sim.value.logs ?? [];
    const ok = acceptable(sim.value.err, logs);
    allOk = allOk && ok;
    console.log(`\n[smoke] direction buyOn=${buyOn}`);
    console.log(`[smoke]   err: ${JSON.stringify(sim.value.err)}`);
    console.log(`[smoke]   unitsConsumed: ${sim.value.unitsConsumed ?? "n/a"}`);
    console.log(`[smoke]   CLMM program in logs: ${logs.some((l) => l.includes(CLMM_PROGRAM))}`);
    console.log(`[smoke]   Orca program in logs: ${logs.some((l) => l.includes(ORCA_PROGRAM))}`);
    console.log(`[smoke]   acceptable (well-formed, both legs reached): ${ok}`);
    for (const l of logs.slice(-12)) console.log(`     ${l}`);
  }
  console.log(`\n[smoke] RESULT: ${allOk ? "PASS" : "FAIL"} (both directions well-formed)`);
  console.log("[smoke] NOTE: only simulateTransaction was called — nothing was sent.");
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
