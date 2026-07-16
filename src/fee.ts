/**
 * Transaction-fee estimation (ADR-0007).
 *
 * Solana charges its fee in lamports (SOL), but detection's profit math is
 * in quote-token (devUSDC) units. This module resolves a real base fee in
 * lamports (fetched once at startup, with a protocol-constant fallback),
 * applies a fixed +20% HEADROOM to that lamport figure only, and converts
 * it to quote units at the live mid price on every cycle.
 *
 * IMPORTANT: the headroom here is a cushion on the *cost estimate* — it is
 * NOT the min-profit threshold and is never merged with it. detect.ts still
 * subtracts this quote-unit fee and then compares the remainder against
 * MIN_PROFIT_THRESHOLD_QUOTE separately (see ADR-0007, Decision §2).
 */
import { midPriceDen, midPriceNum } from "./detect.js";
import type { PoolSnapshot } from "./types.js";

/** Solana protocol base fee per signature (lamports). Fallback only. */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5000n;

/** +20% headroom, applied to the fetched fee lamports before conversion. */
export const FEE_HEADROOM_NUM = 120n;
export const FEE_HEADROOM_DEN = 100n;

/**
 * Apply the ADR-0007 +20% headroom to a raw fee in lamports. Integer math,
 * floored — the cushion only ever slightly over-estimates the cost, never
 * under. Applied to the lamport fee alone, before any unit conversion.
 */
export function applyFeeHeadroom(feeLamports: bigint): bigint {
  return (feeLamports * FEE_HEADROOM_NUM) / FEE_HEADROOM_DEN;
}

/**
 * Convert a lamport fee to quote-token base units at a pool's mid price,
 * reusing detection's exported mid-price helpers so there is one price math.
 * `priceRef` is a live snapshot from the current cycle (repriced per ADR-0007).
 */
export function lamportsFeeToQuote(
  feeLamports: bigint,
  priceRef: PoolSnapshot,
): bigint {
  return (feeLamports * midPriceNum(priceRef)) / midPriceDen(priceRef);
}

/**
 * Resolve the base fee in lamports. Tries the injected live fetcher (a
 * getFeeForMessage call at the call site); on null / non-positive / throw,
 * falls back to the protocol constant × signature count so a transient RPC
 * failure can never hard-fail startup. Returns which path was taken so the
 * caller can log it.
 */
export async function resolveBaseFeeLamports(
  fetchFee: () => Promise<number | null>,
  signatureCount: number,
): Promise<{ lamports: bigint; source: "rpc" | "fallback" }> {
  try {
    const fee = await fetchFee();
    if (fee != null && Number.isFinite(fee) && fee > 0) {
      return { lamports: BigInt(Math.trunc(fee)), source: "rpc" };
    }
  } catch {
    // fall through to the protocol constant
  }
  return {
    lamports: BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(signatureCount),
    source: "fallback",
  };
}
