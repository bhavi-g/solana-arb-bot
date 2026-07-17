import { describe, expect, it } from "vitest";
import { detect, type DetectParams } from "../src/detect.js";
import type { CpmmSnapshot, WhirlpoolSnapshot } from "../src/types.js";

const Q64 = 2n ** 64n;

const pair = {
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "USDC-mint",
  baseDecimals: 9,
  quoteDecimals: 6,
};

function cpmm(
  baseReserve: bigint,
  quoteReserve: bigint,
  feeBps = 0,
): CpmmSnapshot {
  return {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "RayPool111",
    pair,
    fetchedAtMs: 1_700_000_000_000,
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
    fetchedAtMs: 1_700_000_000_000,
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

describe("detect", () => {
  it("returns no-opportunity when both venues price identically", () => {
    // cpmm price = 1 quote/base raw; whirlpool sqrtPrice 2^64 -> price 1
    const d = detect(cpmm(10n ** 12n, 10n ** 12n), whirl(Q64), params());
    expect(d.decision).toBe("no-opportunity");
    expect(Math.abs(d.gapBps)).toBeLessThan(2);
  });

  it("detects buy-on-cpmm/sell-on-whirlpool with exact known profit", () => {
    // cpmm: base 1e12, quote 8e11 -> base is CHEAP there (0.8 vs 1.0)
    // buy leg:  baseOut = 1e6 * 1e12 / (8e11 + 1e6) = 1_249_998 (floor)
    // sell leg at whirlpool price 1: quoteOut = 1_249_998
    // profit = 249_998
    const d = detect(cpmm(10n ** 12n, 8n * 10n ** 11n), whirl(Q64), params());
    expect(d.decision).toBe("opportunity");
    if (d.decision !== "opportunity") return;
    expect(d.direction).toEqual({
      buyOn: "raydium-cpmm",
      sellOn: "orca-whirlpool",
      buyPoolAddress: "RayPool111",
      sellPoolAddress: "OrcaPool111",
    });
    expect(d.quoteIn).toBe(1_000_000n);
    expect(d.baseOut).toBe(1_249_998n);
    expect(d.quoteOut).toBe(1_249_998n);
    expect(d.estNetProfit).toBe(249_998n);
  });

  it("detects the reverse direction (base cheap on whirlpool)", () => {
    // whirlpool price 1, cpmm price 1.25 -> buy on whirlpool, sell on cpmm
    const d = detect(cpmm(10n ** 12n, 125n * 10n ** 10n), whirl(Q64), params());
    expect(d.decision).toBe("opportunity");
    if (d.decision !== "opportunity") return;
    expect(d.direction).toEqual({
      buyOn: "orca-whirlpool",
      sellOn: "raydium-cpmm",
      buyPoolAddress: "OrcaPool111",
      sellPoolAddress: "RayPool111",
    });
    expect(d.estNetProfit > 0n).toBe(true);
  });

  it("gapBps sign follows cpmm-relative-to-whirlpool and magnitude is sane", () => {
    // cpmm 20% cheaper -> gap approx -2000 bps
    const d = detect(cpmm(10n ** 12n, 8n * 10n ** 11n), whirl(Q64), params());
    expect(d.gapBps).toBeLessThan(-1900);
    expect(d.gapBps).toBeGreaterThan(-2100);
  });

  it("respects the min-profit threshold as >= (exact boundary)", () => {
    const base = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ minProfitThresholdQuote: 249_998n }),
    );
    expect(base.decision).toBe("opportunity");

    const above = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ minProfitThresholdQuote: 249_999n }),
    );
    expect(above.decision).toBe("no-opportunity");
    if (above.decision === "no-opportunity") {
      expect(above.reason).toMatch(/threshold/i);
    }
  });

  it("pool fees can flip a marginal gap to unprofitable", () => {
    // 2% gap: cpmm price 0.98 vs whirlpool 1.0
    const cheap = cpmm(10n ** 12n, 98n * 10n ** 10n, 0);
    const cheapWithFees = cpmm(10n ** 12n, 98n * 10n ** 10n, 100); // 1% fee
    const feeWhirl = whirl(Q64, 100); // 1% fee

    expect(detect(cheap, whirl(Q64), params()).decision).toBe("opportunity");
    expect(detect(cheapWithFees, feeWhirl, params()).decision).toBe(
      "no-opportunity",
    );
  });

  it("estimated tx fee is subtracted from net profit", () => {
    const noFee = detect(cpmm(10n ** 12n, 8n * 10n ** 11n), whirl(Q64), params());
    const withFee = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ estTxFeeQuote: 100_000n }),
    );
    if (noFee.decision !== "opportunity" || withFee.decision !== "opportunity") {
      expect.unreachable("both should be opportunities");
    }
    expect(noFee.estNetProfit - withFee.estNetProfit).toBe(100_000n);
  });

  it("slippage buffer on the whirlpool leg reduces profit and can kill the trade", () => {
    const tight = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ slippageToleranceBps: 50 }),
    );
    const loose = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ slippageToleranceBps: 0 }),
    );
    if (tight.decision !== "opportunity" || loose.decision !== "opportunity") {
      expect.unreachable("both should be opportunities");
    }
    expect(tight.estNetProfit < loose.estNetProfit).toBe(true);

    // enormous buffer kills any gap
    const killed = detect(
      cpmm(10n ** 12n, 8n * 10n ** 11n),
      whirl(Q64),
      params({ slippageToleranceBps: 5_000 }),
    );
    expect(killed.decision).toBe("no-opportunity");
  });

  it("throws if snapshots are for different pairs", () => {
    const other = cpmm(10n ** 12n, 10n ** 12n);
    other.pair = { ...pair, quoteMint: "USDT-mint" };
    expect(() => detect(other, whirl(Q64), params())).toThrow(/pair/i);
  });
});
