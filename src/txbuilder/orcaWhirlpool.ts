/**
 * Orca Whirlpool swap instruction.
 * Account order verified 2026-07-16 against
 * whirlpools/programs/whirlpool/src/instructions/swap.rs (main).
 * Tick arrays: 3 arrays starting at the array containing the current
 * tick, walking in the swap direction (a->b: price falls, lower ticks).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Anchor: sha256("global:swap")[0..8]. */
export const WHIRLPOOL_SWAP_DISCRIMINATOR = createHash("sha256")
  .update("global:swap")
  .digest()
  .subarray(0, 8);

export const TICK_ARRAY_SIZE = 88;
// Program constants (token math bounds), from whirlpool src.
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;

export function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

export function tickArrayPda(
  programId: PublicKey,
  whirlpool: PublicKey,
  startIndex: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(startIndex))],
    programId,
  )[0];
}

export function oraclePda(programId: PublicKey, whirlpool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), whirlpool.toBuffer()],
    programId,
  )[0];
}

export interface WhirlpoolSwapParams {
  programId: PublicKey;
  tokenProgram: PublicKey;
  tokenAuthority: PublicKey;
  whirlpool: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenVaultA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultB: PublicKey;
  tickCurrentIndex: number;
  tickSpacing: number;
  /** Input amount (amount_specified_is_input is always true here). */
  amount: bigint;
  /** Minimum output amount — enforces profitability atomically. */
  otherAmountThreshold: bigint;
  aToB: boolean;
}

export function buildWhirlpoolSwapIx(
  p: WhirlpoolSwapParams,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1 + 1);
  data.set(WHIRLPOOL_SWAP_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.amount, 8);
  data.writeBigUInt64LE(p.otherAmountThreshold, 16);
  const sqrtPriceLimit = p.aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  data.writeBigUInt64LE(sqrtPriceLimit & 0xffffffffffffffffn, 24);
  data.writeBigUInt64LE(sqrtPriceLimit >> 64n, 32);
  data.writeUInt8(1, 40); // amount_specified_is_input = true
  data.writeUInt8(p.aToB ? 1 : 0, 41);

  const ticksPerArray = p.tickSpacing * TICK_ARRAY_SIZE;
  const start = tickArrayStartIndex(p.tickCurrentIndex, p.tickSpacing);
  const step = p.aToB ? -ticksPerArray : ticksPerArray;
  const tickArrays = [start, start + step, start + 2 * step].map((s) =>
    tickArrayPda(p.programId, p.whirlpool, s),
  );

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: p.tokenAuthority, isSigner: true, isWritable: false },
      { pubkey: p.whirlpool, isSigner: false, isWritable: true },
      { pubkey: p.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: p.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: p.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: p.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: tickArrays[0]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[1]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[2]!, isSigner: false, isWritable: true },
      { pubkey: oraclePda(p.programId, p.whirlpool), isSigner: false, isWritable: false },
    ],
    data,
  });
}
