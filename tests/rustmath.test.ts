import { describe, expect, it } from "vitest";
import { getAmountOut } from "../src/math/cpmm.js";
import { cpmmAmountOutViaRust, minQuoteOutViaRust } from "../src/rustmath.js";

// Cross-validates the Rust port against the TS implementation it
// replaces in the live path (src/txbuilder/index.ts), using the same
// vectors as tests/cpmm.test.ts, so a divergence between the two
// implementations fails loudly here rather than silently in a build.
describe("rustmath (FFI boundary to rust/arb-math)", () => {
  it("minQuoteOutViaRust matches quoteIn + minProfitThreshold", () => {
    expect(minQuoteOutViaRust(1_000_000n, 50_000n)).toBe(1_050_000n);
    expect(minQuoteOutViaRust(0n, 0n)).toBe(0n);
  });

  it("minQuoteOutViaRust rejects u64 overflow", () => {
    expect(() =>
      minQuoteOutViaRust(2n ** 64n - 1n, 1n),
    ).toThrow(/overflow/);
  });

  it("cpmmAmountOutViaRust agrees with the TS getAmountOut on shared vectors", () => {
    const cases: [bigint, bigint, bigint, number][] = [
      [1000n, 1_000_000n, 1_000_000n, 0],
      [1000n, 1_000_000n, 1_000_000n, 30],
      [50_000n, 2_000_000n, 8_000_000n, 25],
      [123_456n, 3_333_333n, 7_777_777n, 25],
    ];
    for (const [amountIn, reserveIn, reserveOut, feeBps] of cases) {
      const tsResult = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      const rustResult = cpmmAmountOutViaRust(
        amountIn,
        reserveIn,
        reserveOut,
        feeBps,
      );
      expect(rustResult).toBe(tsResult);
    }
  });

  it("cpmmAmountOutViaRust rejects zero reserves", () => {
    expect(() => cpmmAmountOutViaRust(100n, 0n, 1_000_000n, 25)).toThrow(
      /reserves must be > 0/,
    );
  });
});
