import { describe, expect, it } from "vitest";
import { detect, type DetectParams } from "../src/detect.js";
import { detectViaRust } from "../src/rustmath.js";
import type { CpmmSnapshot, WhirlpoolSnapshot } from "../src/types.js";

// Cross-validates the Rust port of detect() (rust/arb-math::detect,
// ADR-0012) against the TS reference implementation it replaces as the
// live call site in main.ts, using the same fixtures as
// tests/detect.test.ts — a divergence between the two fails loudly here.
const Q64 = 2n ** 64n;

const pair = {
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "USDC-mint",
  baseDecimals: 9,
  quoteDecimals: 6,
};

function cpmm(baseReserve: bigint, quoteReserve: bigint, feeBps = 0): CpmmSnapshot {
  return {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "RayPool111",
    pair,
    fetchStartedAtMs: 1_700_000_000_000,
    slot: 100,
    source: "synthetic",
    baseReserve,
    quoteReserve,
    feeBps,
  };
}

function whirl(sqrtPriceX64: bigint, feeBps = 0): WhirlpoolSnapshot {
  return {
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: "OrcaPool111",
    pair,
    fetchStartedAtMs: 1_700_000_000_000,
    slot: 100,
    source: "synthetic",
    sqrtPriceX64,
    liquidity: 10n ** 18n,
    tickCurrentIndex: 0,
    feeBps,
  };
}

function params(overrides: Partial<DetectParams> = {}): DetectParams {
  return {
    tradeSizeQuote: 1_000_000n,
    minProfitThresholdQuote: 10_000n,
    slippageToleranceBps: 0,
    estTxFeeQuote: 0n,
    ...overrides,
  };
}

describe("detectViaRust parity with TS detect()", () => {
  const cases: Array<[CpmmSnapshot, WhirlpoolSnapshot, DetectParams]> = [
    [cpmm(10n ** 12n, 10n ** 12n), whirl(Q64), params()],
    [cpmm(10n ** 12n, 8n * 10n ** 11n), whirl(Q64), params()],
    [cpmm(10n ** 12n, 125n * 10n ** 10n), whirl(Q64), params()],
    [
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ minProfitThresholdQuote: 249_998n }),
    ],
    [
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ minProfitThresholdQuote: 249_999n }),
    ],
    [cpmm(10n ** 12n, 98n * 10n ** 10n, 100), whirl(Q64, 100), params()],
    [
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ estTxFeeQuote: 100_000n }),
    ],
    [
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ slippageToleranceBps: 50 }),
    ],
    [
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ slippageToleranceBps: 5_000 }),
    ],
  ];

  it.each(cases)("decision %# matches between TS and Rust", (a, b, p) => {
    const tsDecision = detect(a, b, p);
    const rustDecision = detectViaRust(a, b, p);
    expect(rustDecision.decision).toBe(tsDecision.decision);
    expect(rustDecision.gapBps).toBe(tsDecision.gapBps);
    if (tsDecision.decision === "opportunity" && rustDecision.decision === "opportunity") {
      expect(rustDecision.direction).toEqual(tsDecision.direction);
      expect(rustDecision.quoteIn).toBe(tsDecision.quoteIn);
      expect(rustDecision.baseOut).toBe(tsDecision.baseOut);
      expect(rustDecision.quoteOut).toBe(tsDecision.quoteOut);
      expect(rustDecision.estNetProfit).toBe(tsDecision.estNetProfit);
      expect(rustDecision.minProfitThreshold).toBe(tsDecision.minProfitThreshold);
    }
  });

  it("throws on mismatched pairs, same as TS", () => {
    const other = cpmm(10n ** 12n, 10n ** 12n);
    other.pair = { ...pair, quoteMint: "USDT-mint" };
    expect(() => detect(other, whirl(Q64), params())).toThrow(/pair/i);
    expect(() => detectViaRust(other, whirl(Q64), params())).toThrow(/pair/i);
  });
});
