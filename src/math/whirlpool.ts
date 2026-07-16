/**
 * Orca Whirlpool price math from the on-chain Q64.64 sqrt price.
 *
 * Phase 1 assumption (documented in the plan and detect.ts): trades are
 * priced at the pool's current spot price; tick-crossing price impact is
 * not modeled and is instead covered by the configured slippage buffer.
 * All conversions are bigint with a single floor division (conservative).
 */

const Q128 = 2n ** 128n;
const BPS = 10_000n;

function checkArgs(amount: bigint, sqrtPriceX64: bigint, feeBps: number): void {
  if (amount < 0n) throw new RangeError("amount must be >= 0");
  if (sqrtPriceX64 <= 0n) throw new RangeError("sqrtPriceX64 must be > 0");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError("feeBps must be an integer in [0, 10000]");
  }
}

/** Quote tokens received for baseIn at spot price, fee on input. */
export function whirlpoolBaseToQuote(
  baseIn: bigint,
  sqrtPriceX64: bigint,
  feeBps: number,
): bigint {
  checkArgs(baseIn, sqrtPriceX64, feeBps);
  // price (quote per base, raw units) = (s / 2^64)^2 = s^2 / 2^128
  return (
    (baseIn * (BPS - BigInt(feeBps)) * sqrtPriceX64 * sqrtPriceX64) /
    (Q128 * BPS)
  );
}

/** Base tokens received for quoteIn at spot price, fee on input. */
export function whirlpoolQuoteToBase(
  quoteIn: bigint,
  sqrtPriceX64: bigint,
  feeBps: number,
): bigint {
  checkArgs(quoteIn, sqrtPriceX64, feeBps);
  return (
    (quoteIn * (BPS - BigInt(feeBps)) * Q128) /
    (sqrtPriceX64 * sqrtPriceX64 * BPS)
  );
}

/**
 * Human-readable price (e.g. USDC per SOL) for logs and console output
 * ONLY — floating point, never used in trade math.
 */
export function sqrtPriceX64ToPrice(
  sqrtPriceX64: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const s = Number(sqrtPriceX64) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}
