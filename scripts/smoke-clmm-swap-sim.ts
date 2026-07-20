/**
 * READ-ONLY smoke check: proves buildClmmSwapV2Ix produces a well-formed
 * Raydium CLMM swap_v2 instruction that SIMULATES against real mainnet
 * pool state (sigVerify:false, surrogate owner) — the live-verification
 * leg the design spec requires (source-only or sim-only is not enough).
 * Only simulateTransaction is ever called; nothing is sent.
 */
import "dotenv/config";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeClmmPool } from "../src/decode/clmm.js";
import { associatedTokenAddress } from "../src/txbuilder/index.js";
import { buildClmmSwapV2Ix } from "../src/txbuilder/raydiumClmm.js";

const POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
const SURROGATE = "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const programId = new PublicKey(CLMM_PROGRAM);
  const pool = new PublicKey(POOL);
  const surrogate = new PublicKey(SURROGATE);

  const poolAcc = await connection.getAccountInfo(pool);
  if (!poolAcc) throw new Error(`pool ${POOL} account not found`);
  const state = decodeClmmPool(poolAcc.data);

  if (state.tokenMint0.toBase58() !== SOL_MINT) {
    throw new Error(
      `expected orientation NORMAL (SOL=mint0), got mint0=${state.tokenMint0.toBase58()} — ` +
        `inputIsToken0 below assumes this orientation`,
    );
  }

  // USDC (mint1) -> SOL (mint0): input is NOT token0.
  const inputAmount = 100_000n; // 0.1 USDC (6 decimals) — smoke size only
  const ix = buildClmmSwapV2Ix({
    programId,
    payer: surrogate,
    ammConfig: state.ammConfig,
    poolState: pool,
    inputTokenAccount: associatedTokenAddress(surrogate, state.tokenMint1),
    outputTokenAccount: associatedTokenAddress(surrogate, state.tokenMint0),
    inputVault: state.tokenVault1,
    outputVault: state.tokenVault0,
    observationState: state.observationKey,
    inputVaultMint: state.tokenMint1,
    outputVaultMint: state.tokenMint0,
    tickCurrentIndex: state.tickCurrentIndex,
    tickSpacing: state.tickSpacing,
    amount: inputAmount,
    otherAmountThreshold: 0n,
    inputIsToken0: false,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: surrogate,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  console.log(`[smoke] simulate err: ${JSON.stringify(sim.value.err)}`);
  console.log(`[smoke] unitsConsumed: ${sim.value.unitsConsumed ?? "n/a"}`);
  const logs = sim.value.logs ?? [];
  console.log(`[smoke] CLMM program in logs: ${logs.some((l) => l.includes(CLMM_PROGRAM))}`);
  console.log(`[smoke] logs tail:`);
  for (const l of logs.slice(-12)) console.log(`   ${l}`);
  console.log("[smoke] NOTE: only simulateTransaction was called — nothing was sent.");
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
