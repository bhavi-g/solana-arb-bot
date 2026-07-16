import { describe, expect, it } from "vitest";
import {
  whirlpoolBaseToQuote,
  whirlpoolQuoteToBase,
  sqrtPriceX64ToPrice,
} from "../src/math/whirlpool.js";

const Q64 = 2n ** 64n;

describe("whirlpool sqrtPriceX64 math", () => {
  it("sqrtPrice = 2^64 means price 1 (quote per base, raw units)", () => {
    expect(whirlpoolBaseToQuote(1_000_000n, Q64, 0)).toBe(1_000_000n);
    expect(whirlpoolQuoteToBase(1_000_000n, Q64, 0)).toBe(1_000_000n);
  });

  it("sqrtPrice = 2^65 means price 4", () => {
    expect(whirlpoolBaseToQuote(1_000n, 2n * Q64, 0)).toBe(4_000n);
    expect(whirlpoolQuoteToBase(4_000n, 2n * Q64, 0)).toBe(1_000n);
  });

  it("fee on input reduces output", () => {
    const noFee = whirlpoolBaseToQuote(1_000_000n, 3n * Q64, 0);
    const fee = whirlpoolBaseToQuote(1_000_000n, 3n * Q64, 30);
    expect(fee < noFee).toBe(true);
    // 30bps of 9_000_000 = 27_000 exactly
    expect(noFee - fee).toBe(27_000n);
  });

  it("base->quote->base roundtrip loses at most rounding dust", () => {
    const s = 7_144_300_000_000_000_000n; // ~0.15 raw price, SOL/USDC-like
    const baseIn = 1_000_000_000n; // 1 SOL
    const quote = whirlpoolBaseToQuote(baseIn, s, 0);
    const backToBase = whirlpoolQuoteToBase(quote, s, 0);
    expect(backToBase <= baseIn).toBe(true);
    expect(baseIn - backToBase < 10n).toBe(true);
  });

  it("sqrtPriceX64ToPrice converts to human decimal price (logging only)", () => {
    // raw price 0.15 quote-atom/base-atom with base 9 decimals, quote 6:
    // human = 0.15 * 10^(9-6) = 150
    const s = 7_144_300_000_000_000_000n;
    const human = sqrtPriceX64ToPrice(s, 9, 6);
    expect(human).toBeGreaterThan(149);
    expect(human).toBeLessThan(151);
  });

  it("returns 0 for zero input", () => {
    expect(whirlpoolBaseToQuote(0n, Q64, 25)).toBe(0n);
    expect(whirlpoolQuoteToBase(0n, Q64, 25)).toBe(0n);
  });

  it("throws on non-positive sqrtPrice or bad fee", () => {
    expect(() => whirlpoolBaseToQuote(1n, 0n, 0)).toThrow();
    expect(() => whirlpoolQuoteToBase(1n, -1n, 0)).toThrow();
    expect(() => whirlpoolBaseToQuote(1n, Q64, 10_001)).toThrow();
  });
});
