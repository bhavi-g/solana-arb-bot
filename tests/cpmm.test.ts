import { describe, expect, it } from "vitest";
import { getAmountOut } from "../src/math/cpmm.js";

describe("getAmountOut (constant product x*y=k with fee on input)", () => {
  it("computes the classic no-fee case exactly: 1000 in against 1M/1M reserves", () => {
    // out = dx*y/(x+dx) = 1000 * 1_000_000 / 1_001_000 = 999.0009... -> floor 999
    expect(getAmountOut(1000n, 1_000_000n, 1_000_000n, 0)).toBe(999n);
  });

  it("applies a 30bps input fee (Uniswap-v2-style single rounding)", () => {
    // aFee = 1000*9970; out = aFee*y / (x*10000 + aFee)
    //      = 9_970_000 * 1_000_000 / (10_000_000_000 + 9_970_000) = 995.98 -> 995
    expect(getAmountOut(1000n, 1_000_000n, 1_000_000n, 30)).toBe(995n);
  });

  it("fee strictly reduces output", () => {
    const noFee = getAmountOut(50_000n, 2_000_000n, 8_000_000n, 0);
    const withFee = getAmountOut(50_000n, 2_000_000n, 8_000_000n, 25);
    expect(withFee < noFee).toBe(true);
  });

  it("output is monotonically increasing in input", () => {
    const small = getAmountOut(1_000n, 1_000_000n, 1_000_000n, 25);
    const large = getAmountOut(2_000n, 1_000_000n, 1_000_000n, 25);
    expect(large > small).toBe(true);
  });

  it("effective price worsens with size (price impact)", () => {
    // quote-per-base effective price of buying base with quote:
    // for a larger quote input, base-out per quote-in must be smaller.
    const out1 = getAmountOut(10_000n, 10_000_000n, 5_000_000n, 25);
    const out2 = getAmountOut(1_000_000n, 10_000_000n, 5_000_000n, 25);
    // compare out/in as fractions via cross-multiplication (no floats)
    expect(out2 * 10_000n < out1 * 1_000_000n).toBe(true);
  });

  it("never pays out the full opposite reserve even for absurd input", () => {
    const out = getAmountOut(10n ** 18n, 1_000_000n, 1_000_000n, 0);
    expect(out < 1_000_000n).toBe(true);
  });

  it("preserves or grows k (fees accrue to the pool)", () => {
    const x = 3_333_333n;
    const y = 7_777_777n;
    const dx = 123_456n;
    const out = getAmountOut(dx, x, y, 25);
    const kBefore = x * y;
    const kAfter = (x + dx) * (y - out);
    expect(kAfter >= kBefore).toBe(true);
  });

  it("returns 0 for zero input", () => {
    expect(getAmountOut(0n, 1_000_000n, 1_000_000n, 25)).toBe(0n);
  });

  it("returns 0 when the fee consumes everything (feeBps=10000)", () => {
    expect(getAmountOut(1000n, 1_000_000n, 1_000_000n, 10_000)).toBe(0n);
  });

  it("throws on empty reserves", () => {
    expect(() => getAmountOut(1000n, 0n, 1_000_000n, 25)).toThrow();
    expect(() => getAmountOut(1000n, 1_000_000n, 0n, 25)).toThrow();
  });

  it("throws on negative input or out-of-range fee", () => {
    expect(() => getAmountOut(-1n, 1_000_000n, 1_000_000n, 25)).toThrow();
    expect(() => getAmountOut(1000n, 1_000_000n, 1_000_000n, -1)).toThrow();
    expect(() => getAmountOut(1000n, 1_000_000n, 1_000_000n, 10_001)).toThrow();
  });
});
