/**
 * Constant-product AMM math (x*y=k), all bigint, fee charged on input,
 * single floor division at the end (Uniswap-v2-style) so rounding always
 * favors the pool — our output estimate is conservative.
 */

const BPS_DENOMINATOR = 10_000n;

/**
 * Amount of the output token received for `amountIn` of the input token,
 * against reserves (reserveIn, reserveOut), with `feeBps` charged on input.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn < 0n) throw new RangeError("amountIn must be >= 0");
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new RangeError("reserves must be > 0");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError("feeBps must be an integer in [0, 10000]");
  }
  if (amountIn === 0n) return 0n;

  const amountInAfterFee = amountIn * (BPS_DENOMINATOR - BigInt(feeBps));
  return (
    (amountInAfterFee * reserveOut) /
    (reserveIn * BPS_DENOMINATOR + amountInAfterFee)
  );
}
