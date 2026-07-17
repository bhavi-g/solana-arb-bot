/**
 * Realistic cost model (ADR-0009). Turns a detected opportunity plus
 * simulation data into a fully-costed record with BOTH gross and net.
 *
 * grossProfit = quoteOut − quoteIn from the real AMM curve math on both
 * legs. Pool fees, price impact, and slippage are ALREADY inside that
 * number — they are how the curve prices each swap — so they are not
 * separate subtractions here. The explicit subtractions are the costs the
 * curve cannot see: base tx fee (ADR-0007), priority fee (measured CU ×
 * live CU price), and a MODELED Jito tip (accounting only: no tip is ever
 * constructed, paid, or sent in Phase 2).
 */
import { lamportsFeeToQuote } from "./fee.js";
import type { PoolSnapshot } from "./types.js";

/**
 * Fallback CU price when getRecentPrioritizationFees yields no positive
 * samples. Zeros are filtered before taking the median: many slots carry
 * zero-fee transactions, and including them would underestimate the price
 * of timely inclusion — we prefer to overestimate costs.
 */
export const DEFAULT_CU_PRICE_MICRO_LAMPORTS = 1_000n;

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const BPS = 10_000n;

export interface CostInputs {
  /** quoteOut − quoteIn (curve math; fees/impact/slippage included). */
  grossProfitQuote: bigint;
  /** ADR-0007 base fee in quote units, headroom included. */
  baseFeeQuote: bigint;
  /** Live median CU price (micro-lamports per CU). */
  cuPriceMicroLamports: bigint;
  /** Modeled Jito tip fraction in basis points (owner band 5000–6000). */
  jitoTipFractionBps: number;
  /** Snapshot used to convert lamports → quote (same math as ADR-0007). */
  priceRef: PoolSnapshot;
}

export interface CostBreakdown {
  grossProfit: bigint;
  baseFee: bigint;
  /** null when simulation failed (no measured CU) — never fabricated. */
  priorityFee: bigint | null;
  jitoTip: bigint;
  jitoTipFraction: number;
  /** null when priorityFee is null. */
  netProfit: bigint | null;
  netComputable: boolean;
}

export function computeCosts(
  inp: CostInputs,
  cuLimit: number | null,
): CostBreakdown {
  const jitoTip =
    inp.grossProfitQuote > 0n
      ? (inp.grossProfitQuote * BigInt(inp.jitoTipFractionBps)) / BPS
      : 0n;
  const jitoTipFraction = inp.jitoTipFractionBps / 10_000;

  if (cuLimit === null) {
    return {
      grossProfit: inp.grossProfitQuote,
      baseFee: inp.baseFeeQuote,
      priorityFee: null,
      jitoTip,
      jitoTipFraction,
      netProfit: null,
      netComputable: false,
    };
  }

  // Priority fee lamports = ceil(cuLimit × cuPrice / 1e6): round UP so the
  // cost estimate never flatters an opportunity.
  const micro = BigInt(cuLimit) * inp.cuPriceMicroLamports;
  const priorityLamports =
    (micro + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  const priorityFee = lamportsFeeToQuote(priorityLamports, inp.priceRef);

  return {
    grossProfit: inp.grossProfitQuote,
    baseFee: inp.baseFeeQuote,
    priorityFee,
    jitoTip,
    jitoTipFraction,
    netProfit: inp.grossProfitQuote - inp.baseFeeQuote - priorityFee - jitoTip,
    netComputable: true,
  };
}

/** Median of positive prioritization-fee samples; fallback when none. */
export function medianCuPriceMicroLamports(
  fees: ReadonlyArray<{ prioritizationFee: number }>,
): bigint {
  const positive = fees
    .map((f) => f.prioritizationFee)
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);
  if (positive.length === 0) return DEFAULT_CU_PRICE_MICRO_LAMPORTS;
  return BigInt(positive[Math.floor(positive.length / 2)]!);
}
