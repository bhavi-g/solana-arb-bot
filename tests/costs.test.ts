import { describe, expect, it } from "vitest";
import {
  computeCosts,
  medianCuPriceMicroLamports,
  DEFAULT_CU_PRICE_MICRO_LAMPORTS,
  type CostInputs,
} from "../src/costs.js";
import type { PoolSnapshot } from "../src/types.js";

// CPMM priceRef: 150,000 USDC (6dp) / 1,000 SOL (9dp) => midPriceNum/Den =
// quoteReserve/baseReserve = 0.00015 quote base units per lamport.
const priceRef: PoolSnapshot = {
  kind: "cpmm",
  dex: "raydium-cpmm",
  poolAddress: "P",
  pair: { baseMint: "b", quoteMint: "q", baseDecimals: 9, quoteDecimals: 6 },
  fetchedAtMs: 0,
  slot: 1,
  source: "test",
  baseReserve: 1_000_000_000_000n, // 1,000 SOL in lamports
  quoteReserve: 150_000_000_000n, // 150,000 USDC in base units
  feeBps: 25,
};

const inputs: CostInputs = {
  grossProfitQuote: 1_000_000n, // 1 USDC gross
  baseFeeQuote: 900n, // ADR-0007 quote-converted base fee (headroom included)
  cuPriceMicroLamports: 5_000n,
  jitoTipFractionBps: 5_500,
  priceRef,
};

describe("computeCosts", () => {
  it("computes priority fee from cuLimit × cuPrice (ceil), converted to quote", () => {
    // 200_000 CU × 5_000 μlam = 1e9 μlam = 1_000 lamports
    // → quote: 1_000 × 150_000_000_000 / 1_000_000_000_000 = 150
    const c = computeCosts(inputs, 200_000);
    expect(c.priorityFee).toBe(150n);
  });

  it("rounds priority lamports UP, quote conversion floors (sub-unit → 0)", () => {
    // 1 CU × 5_000 μlam = 5_000 μlam = 0.005 lamports → ceil to 1 lamport
    // 1 lamport → 0.15 quote base units → floors to 0
    const c = computeCosts(inputs, 1);
    expect(c.priorityFee).toBe(0n);
  });

  it("models the Jito tip as tipFractionBps of POSITIVE gross profit", () => {
    const c = computeCosts(inputs, 200_000);
    expect(c.jitoTip).toBe(550_000n); // 55% of 1_000_000
    expect(c.jitoTipFraction).toBeCloseTo(0.55);
  });

  it("no tip on zero/negative gross", () => {
    const c = computeCosts({ ...inputs, grossProfitQuote: -5n }, 200_000);
    expect(c.jitoTip).toBe(0n);
    expect(computeCosts({ ...inputs, grossProfitQuote: 0n }, 200_000).jitoTip).toBe(0n);
  });

  it("netProfit = gross − baseFee − priorityFee − jitoTip", () => {
    const c = computeCosts(inputs, 200_000);
    expect(c.netProfit).toBe(1_000_000n - 900n - 150n - 550_000n);
    expect(c.netComputable).toBe(true);
  });

  it("cuLimit=null (sim failed): net is uncomputable, never fabricated", () => {
    const c = computeCosts(inputs, null);
    expect(c.priorityFee).toBeNull();
    expect(c.netProfit).toBeNull();
    expect(c.netComputable).toBe(false);
    expect(c.grossProfit).toBe(1_000_000n); // gross still reported
  });
});

describe("medianCuPriceMicroLamports", () => {
  it("returns the median of positive samples (zeros filtered — conservative)", () => {
    const fees = [0, 0, 100, 500, 9000].map((prioritizationFee) => ({ prioritizationFee }));
    expect(medianCuPriceMicroLamports(fees)).toBe(500n);
  });
  it("falls back to the documented default when no positive samples", () => {
    expect(medianCuPriceMicroLamports([])).toBe(DEFAULT_CU_PRICE_MICRO_LAMPORTS);
    expect(medianCuPriceMicroLamports([{ prioritizationFee: 0 }])).toBe(
      DEFAULT_CU_PRICE_MICRO_LAMPORTS,
    );
  });
});
