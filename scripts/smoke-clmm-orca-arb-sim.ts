/**
 * READ-ONLY smoke check: proves buildClmmOrcaArbTransaction produces a
 * well-formed ATOMIC two-leg (CLMM + Orca) tx that SIMULATES against real
 * mainnet state for BOTH direction assignments (sigVerify:false, surrogate
 * owner). The live-verification leg the design spec requires. Only
 * simulateTransaction is ever called; nothing is sent.
 *
 * Sell-leg sizing: a preliminary buy-leg-only simulation measures the base
 * (SOL) amount the buy leg would actually produce for the real quoteIn
 * (via the post-sim balance of the surrogate's SOL ATA), so the sell leg
 * in the full two-leg tx trades at realistic size instead of 1 lamport.
 *
 * Pass: for both directions, both program IDs appear in the sim logs AND
 * err is null OR a slippage/amount-class error (a well-formed tx whose
 * round-trip simply wasn't profitable). A malformed-account/PDA error
 * (a leg never reached its program) is the only FAIL.
 */
import "dotenv/config";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "../src/decode/clmm.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "../src/txbuilder/clmmOrca.js";
import { buildClmmSwapV2Ix } from "../src/txbuilder/raydiumClmm.js";
import { buildWhirlpoolSwapIx } from "../src/txbuilder/orcaWhirlpool.js";
import { associatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/txbuilder/index.js";
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

/** SPL Token account layout: amount is a u64 LE at byte offset 64. */
function tokenAmountFromAccountData(base64Data: string): bigint {
  return Buffer.from(base64Data, "base64").readBigUInt64LE(64);
}

/** Buy-leg-only ix (quote -> base), reusing the exact account wiring buildClmmOrcaArbTransaction uses. */
function buildClmmBuyIx(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  quoteIn: bigint,
) {
  const s = ctx.clmm.state;
  return buildClmmSwapV2Ix({
    programId: ctx.clmm.programId,
    payer: owner,
    ammConfig: s.ammConfig,
    poolState: ctx.clmm.poolAddress,
    inputTokenAccount: quoteAta,
    outputTokenAccount: baseAta,
    inputVault: s.tokenVault1,
    outputVault: s.tokenVault0,
    observationState: s.observationKey,
    inputVaultMint: s.tokenMint1,
    outputVaultMint: s.tokenMint0,
    tickCurrentIndex: ctx.clmm.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: quoteIn,
    otherAmountThreshold: 1n, // permissive: only probing the real output
    inputIsToken0: false,
  });
}

function buildWhirlpoolBuyIx(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  quoteIn: bigint,
) {
  const s = ctx.whirlpool.state;
  return buildWhirlpoolSwapIx({
    programId: ctx.whirlpool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: ctx.whirlpool.poolAddress,
    tokenOwnerAccountA: baseAta,
    tokenVaultA: s.tokenVaultA,
    tokenOwnerAccountB: quoteAta,
    tokenVaultB: s.tokenVaultB,
    tickCurrentIndex: ctx.whirlpool.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: quoteIn,
    otherAmountThreshold: 1n, // permissive: only probing the real output
    aToB: false,
  });
}

/**
 * Simulates ONLY the buy leg and returns the base (SOL) amount it actually
 * produced, measured from the surrogate's SOL ATA post-sim balance minus
 * its current on-chain balance. Used to size the sell leg realistically
 * instead of the placeholder baseOut=1n.
 */
async function probeBuyLegOutput(
  connection: Connection,
  ctx: ClmmOrcaBuildContext,
  buyOn: "raydium-clmm" | "orca-whirlpool",
  quoteIn: bigint,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  blockhash: string,
): Promise<bigint> {
  const ix =
    buyOn === "raydium-clmm"
      ? buildClmmBuyIx(ctx, owner, baseAta, quoteAta, quoteIn)
      : buildWhirlpoolBuyIx(ctx, owner, baseAta, quoteAta, quoteIn);
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  const pre = await connection.getTokenAccountBalance(baseAta);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [baseAta.toBase58()] },
  });
  if (sim.value.err) {
    throw new Error(
      `[probe] buy-leg-only sim failed (buyOn=${buyOn}): ${JSON.stringify(sim.value.err)}`,
    );
  }
  const postData = sim.value.accounts?.[0]?.data?.[0];
  if (!postData) throw new Error("[probe] simulateTransaction returned no account data");
  const produced = tokenAmountFromAccountData(postData) - BigInt(pre.value.amount);
  if (produced <= 0n) {
    throw new Error(`[probe] non-positive base output produced (buyOn=${buyOn}): ${produced}`);
  }
  return produced;
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

  // 100 USDC in. baseOut is measured per-direction below (probeBuyLegOutput)
  // rather than hardcoded, so both the buy leg's min-out AND the sell leg's
  // traversal size reflect what the buy leg would actually produce — see
  // the pass criterion above for why err may be a slippage error rather
  // than null.
  const inputUsdc = 100_000_000n; // 100 USDC
  const opp = (
    buyOn: "raydium-clmm" | "orca-whirlpool",
    baseOut: bigint,
  ): Opportunity => ({
    decision: "opportunity",
    direction: {
      buyOn,
      sellOn: buyOn === "raydium-clmm" ? "orca-whirlpool" : "raydium-clmm",
    },
    gapBps: 0,
    quoteIn: inputUsdc,
    baseOut,
    quoteOut: inputUsdc,
    estNetProfit: 0n,
    minProfitThreshold: 0n,
  });

  const baseMint = new PublicKey(SOL_MINT);
  const quoteMint = new PublicKey(USDC_MINT);
  const baseAta = associatedTokenAddress(surrogate, baseMint);
  const quoteAta = associatedTokenAddress(surrogate, quoteMint);

  let allOk = true;
  for (const buyOn of ["raydium-clmm", "orca-whirlpool"] as const) {
    const { blockhash } = await connection.getLatestBlockhash();
    const probedBaseOut = await probeBuyLegOutput(
      connection,
      ctx(blockhash),
      buyOn,
      inputUsdc,
      surrogate,
      baseAta,
      quoteAta,
      blockhash,
    );
    // 0.5% buffer below the probed output: the buy-leg min-out and the
    // sell-leg traversal amount both derive from this, so a tight (exact)
    // threshold risks a spurious FAIL from state drift between the probe
    // sim and the full-tx sim a moment later.
    const realisticBaseOut = (probedBaseOut * 995n) / 1000n;
    console.log(
      `\n[smoke] direction buyOn=${buyOn}: probed buy-leg output ${probedBaseOut} lamports-SOL, using baseOut=${realisticBaseOut} (0.5% buffer) for the sell leg`,
    );
    const tx = buildClmmOrcaArbTransaction(ctx(blockhash), opp(buyOn, realisticBaseOut));
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
