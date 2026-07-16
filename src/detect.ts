/**
 * Opportunity detection: pure function over two PoolSnapshots.
 *
 * Evaluates BOTH directions (buy base on A / sell on B, and the reverse)
 * with fee-aware AMM math, subtracts the estimated transaction fee, and
 * flags an opportunity only when the better direction's net profit clears
 * the configured minimum threshold (>=). The threshold is a parameter and
 * is never weakened here (docs/NEVER_DO.md).
 *
 * Whirlpool legs are priced at spot (see src/math/whirlpool.ts) and then
 * haircut by the slippage buffer, since tick-crossing impact is not
 * modeled in Phase 1. CPMM legs use exact x*y=k impact, so no buffer.
 */
import { getAmountOut } from "./math/cpmm.js";
import {
  whirlpoolBaseToQuote,
  whirlpoolQuoteToBase,
} from "./math/whirlpool.js";
import type { Decision, PoolSnapshot } from "./types.js";

export interface DetectParams {
  /** Quote-token base units spent on the buy leg. */
  tradeSizeQuote: bigint;
  /** Minimum net profit (quote base units) to flag an opportunity. */
  minProfitThresholdQuote: bigint;
  /** Haircut applied to whirlpool legs, basis points. */
  slippageToleranceBps: number;
  /** Estimated tx fee (base fee + priority), converted to quote units. */
  estTxFeeQuote: bigint;
}

const BPS = 10_000n;
const Q128 = 2n ** 128n;

export function detect(
  a: PoolSnapshot,
  b: PoolSnapshot,
  p: DetectParams,
): Decision {
  if (
    a.pair.baseMint !== b.pair.baseMint ||
    a.pair.quoteMint !== b.pair.quoteMint
  ) {
    throw new Error(
      `snapshots are for different pairs: ${a.pair.baseMint}/${a.pair.quoteMint} vs ${b.pair.baseMint}/${b.pair.quoteMint}`,
    );
  }

  const gapBps = computeGapBps(a, b);

  const forward = evalDirection(a, b, p); // buy base on a, sell on b
  const backward = evalDirection(b, a, p); // buy base on b, sell on a
  const best = forward.estNetProfit >= backward.estNetProfit ? forward : backward;

  if (best.estNetProfit >= p.minProfitThresholdQuote) {
    return {
      decision: "opportunity",
      direction: { buyOn: best.buyPool.dex, sellOn: best.sellPool.dex },
      gapBps,
      quoteIn: p.tradeSizeQuote,
      baseOut: best.baseOut,
      quoteOut: best.quoteOut,
      estNetProfit: best.estNetProfit,
      minProfitThreshold: p.minProfitThresholdQuote,
    };
  }

  return {
    decision: "no-opportunity",
    gapBps,
    reason:
      `best direction (buy ${best.buyPool.dex}, sell ${best.sellPool.dex}) ` +
      `nets ${best.estNetProfit} quote units, below threshold ${p.minProfitThresholdQuote}`,
  };
}

interface LegResult {
  buyPool: PoolSnapshot;
  sellPool: PoolSnapshot;
  baseOut: bigint;
  quoteOut: bigint;
  estNetProfit: bigint;
}

function evalDirection(
  buyPool: PoolSnapshot,
  sellPool: PoolSnapshot,
  p: DetectParams,
): LegResult {
  const baseOut = quoteToBase(buyPool, p.tradeSizeQuote, p.slippageToleranceBps);
  const quoteOut = baseToQuote(sellPool, baseOut, p.slippageToleranceBps);
  return {
    buyPool,
    sellPool,
    baseOut,
    quoteOut,
    estNetProfit: quoteOut - p.tradeSizeQuote - p.estTxFeeQuote,
  };
}

function quoteToBase(
  snap: PoolSnapshot,
  quoteIn: bigint,
  slippageBps: number,
): bigint {
  if (snap.kind === "cpmm") {
    return getAmountOut(quoteIn, snap.quoteReserve, snap.baseReserve, snap.feeBps);
  }
  const atSpot = whirlpoolQuoteToBase(quoteIn, snap.sqrtPriceX64, snap.feeBps);
  return applyHaircut(atSpot, slippageBps);
}

function baseToQuote(
  snap: PoolSnapshot,
  baseIn: bigint,
  slippageBps: number,
): bigint {
  if (snap.kind === "cpmm") {
    return getAmountOut(baseIn, snap.baseReserve, snap.quoteReserve, snap.feeBps);
  }
  const atSpot = whirlpoolBaseToQuote(baseIn, snap.sqrtPriceX64, snap.feeBps);
  return applyHaircut(atSpot, slippageBps);
}

function applyHaircut(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * Signed mid-price gap of pool A relative to pool B, in basis points
 * (negative = base token is cheaper on A). Diagnostic only — decisions
 * use the executable-amount math above.
 */
function computeGapBps(a: PoolSnapshot, b: PoolSnapshot): number {
  // gap = (pA/pB - 1) * 10000, one division so bigint precision holds
  const num = midPriceNum(a) * midPriceDen(b) * BPS;
  const den = midPriceDen(a) * midPriceNum(b);
  return Number(num / den) - 10_000;
}

/** Mid price as a fraction num/den (quote per base, raw units). */
function midPriceNum(s: PoolSnapshot): bigint {
  return s.kind === "cpmm" ? s.quoteReserve : s.sqrtPriceX64 * s.sqrtPriceX64;
}

function midPriceDen(s: PoolSnapshot): bigint {
  return s.kind === "cpmm" ? s.baseReserve : Q128;
}
