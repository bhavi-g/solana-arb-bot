/**
 * Raydium CLMM swap_v2 instruction builder.
 * Account order, writable/signer flags, and instruction data layout
 * verified against raydium-io/raydium-clmm
 * programs/amm/src/instructions/swap_v2.rs @ 03b44b7 (master, 2026-07-20)
 * AND cross-checked against the vendored @raydium-io/raydium-sdk-v2
 * reference builder (node_modules/@raydium-io/raydium-sdk-v2/src/raydium/
 * clmm/instrument.ts, swapV2Instruction). Both checks are required — do
 * not trust one alone. Final confirmation is the mainnet simulation
 * smoke-check (scripts/smoke-clmm-swap-sim.ts).
 *
 * Tick arrays: fixed 3-array heuristic mirroring orcaWhirlpool.ts (not
 * full tick_array_bitmap discovery) — see design spec
 * docs/superpowers/specs/2026-07-20-raydium-clmm-swapv2-builder-design.md.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Anchor: sha256("global:swap_v2")[0..8]. */
export const CLMM_SWAP_V2_DISCRIMINATOR = createHash("sha256")
  .update("global:swap_v2")
  .digest()
  .subarray(0, 8);

// CLMM's array size (60) differs from Orca's (88) — libraries/constants.ts.
export const CLMM_TICK_ARRAY_SIZE = 60;
// Program constants (token math bounds), from raydium-clmm
// libraries/constants.ts. MIN happens to equal Orca's MIN_SQRT_PRICE;
// MAX does NOT — CLMM defines its own bounds independently.
export const CLMM_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const CLMM_MAX_SQRT_PRICE_X64 = 79_226_673_521_066_979_257_578_248_091n;

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export function clmmTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * CLMM_TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Seed is ["tick_array", pool, startIndex as i32 BIG-ENDIAN] — the
 * critical divergence from Orca, whose seed is the start index as an
 * ASCII decimal string. Verified against raydium-clmm's
 * i32ToBytesBE (writeInt32BE) via the vendored SDK's getPdaTickArrayAddress.
 */
export function clmmTickArrayPda(
  programId: PublicKey,
  pool: PublicKey,
  startIndex: number,
): PublicKey {
  const startIndexBuf = Buffer.alloc(4);
  startIndexBuf.writeInt32BE(startIndex, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), pool.toBuffer(), startIndexBuf],
    programId,
  )[0];
}

export function tickArrayBitmapExtensionPda(
  programId: PublicKey,
  pool: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()],
    programId,
  )[0];
}
