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
import { TOKEN_PROGRAM_ID } from "./index.js";

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

export interface ClmmSwapV2Params {
  programId: PublicKey;
  payer: PublicKey;
  ammConfig: PublicKey;
  poolState: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  observationState: PublicKey;
  inputVaultMint: PublicKey;
  outputVaultMint: PublicKey;
  tickCurrentIndex: number;
  tickSpacing: number;
  /** Input amount (is_base_input is always true here). */
  amount: bigint;
  /** Minimum output amount — enforces profitability atomically. */
  otherAmountThreshold: bigint;
  /**
   * Whether the INPUT side is the pool's token_mint_0. The
   * input/output accounts above are already resolved by the caller
   * (swap_v2's accounts are literally "input_*"/"output_*", unlike
   * Orca's fixed A/B ordering) — this flag does NOT reorder them. It
   * independently drives the tick-array walk direction and the
   * sqrt_price_limit_x64 bound, because swap_v2's instruction DATA
   * carries no separate zero_for_one byte: the program infers
   * direction on-chain by comparing input_vault_mint to the pool's
   * token_mint_0, so the client must still supply a price limit
   * consistent with that same direction.
   */
  inputIsToken0: boolean;
}

export function buildClmmSwapV2Ix(p: ClmmSwapV2Params): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1);
  data.set(CLMM_SWAP_V2_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.amount, 8);
  data.writeBigUInt64LE(p.otherAmountThreshold, 16);
  const sqrtPriceLimit = p.inputIsToken0 ? CLMM_MIN_SQRT_PRICE_X64 : CLMM_MAX_SQRT_PRICE_X64;
  data.writeBigUInt64LE(sqrtPriceLimit & 0xffffffffffffffffn, 24);
  data.writeBigUInt64LE(sqrtPriceLimit >> 64n, 32);
  data.writeUInt8(1, 40); // is_base_input = true

  const ticksPerArray = p.tickSpacing * CLMM_TICK_ARRAY_SIZE;
  const start = clmmTickArrayStartIndex(p.tickCurrentIndex, p.tickSpacing);
  const step = p.inputIsToken0 ? -ticksPerArray : ticksPerArray;
  const tickArrays = [start, start + step, start + 2 * step].map((s) =>
    clmmTickArrayPda(p.programId, p.poolState, s),
  );

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: false },
      { pubkey: p.ammConfig, isSigner: false, isWritable: false },
      { pubkey: p.poolState, isSigner: false, isWritable: true },
      { pubkey: p.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.inputVault, isSigner: false, isWritable: true },
      { pubkey: p.outputVault, isSigner: false, isWritable: true },
      { pubkey: p.observationState, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: p.inputVaultMint, isSigner: false, isWritable: false },
      { pubkey: p.outputVaultMint, isSigner: false, isWritable: false },
      {
        pubkey: tickArrayBitmapExtensionPda(p.programId, p.poolState),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: tickArrays[0]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[1]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[2]!, isSigner: false, isWritable: true },
    ],
    data,
  });
}
