import { describe, expect, it } from "vitest";
import { buildSeedPlan, type SeedPlanParams } from "../src/seed/plan.js";

// Baseline: 150 devUSDC per WSOL. base=WSOL(9dp), quote=devUSDC(6dp).
// mid price in raw units = 150 * 10^6 / 10^9 = 0.15 quote-raw per base-raw
// expressed exactly as the rational 150_000_000 / 1_000_000_000.
function params(overrides: Partial<SeedPlanParams> = {}): SeedPlanParams {
  return {
    cluster: "devnet",
    baseDepositRaw: 1_000_000_000n, // 1 WSOL into each pool's base side
    midPrice: { num: 150_000_000n, den: 1_000_000_000n },
    gapBps: 200, // raydium base price 2% below orca -> buy on raydium
    minQuoteDepositRaw: 1_000_000n, // >= 1 devUSDC each side (non-dust)
    available: { baseRaw: 5_000_000_000n, quoteRaw: 500_000_000n },
    ...overrides,
  };
}

describe("buildSeedPlan — safety guards", () => {
  it("refuses to plan against mainnet (NEVER_DO #1)", () => {
    expect(() => buildSeedPlan(params({ cluster: "mainnet-beta" }))).toThrow(
      /mainnet/i,
    );
  });
});

describe("buildSeedPlan — deposit math", () => {
  it("sets the orca pool's quote deposit at exactly the mid price", () => {
    // 1 WSOL (1e9 raw) at 0.15 quote-raw/base-raw -> 150_000_000 quote raw.
    const plan = buildSeedPlan(params());
    expect(plan.orca.baseRaw).toBe(1_000_000_000n);
    expect(plan.orca.quoteRaw).toBe(150_000_000n);
  });

  it("sets the raydium pool's quote deposit gapBps below mid (base cheaper)", () => {
    // raydium price = 0.15 * (10000 - 200)/10000 = 0.147 quote-raw/base-raw
    // -> 1e9 * 0.147 = 147_000_000 quote raw.
    const plan = buildSeedPlan(params());
    expect(plan.raydium.baseRaw).toBe(1_000_000_000n);
    expect(plan.raydium.quoteRaw).toBe(147_000_000n);
  });

  it("reports totals across both pools", () => {
    const plan = buildSeedPlan(params());
    expect(plan.totalBaseRaw).toBe(2_000_000_000n); // 1 WSOL per pool
    expect(plan.totalQuoteRaw).toBe(297_000_000n); // 150M + 147M
  });

  it("reports the realized price gap between the two pools (bps)", () => {
    // raydium base is ~200bps cheaper than orca -> negative gap of that size.
    const plan = buildSeedPlan(params());
    expect(plan.expectedGapBps).toBeLessThan(-190);
    expect(plan.expectedGapBps).toBeGreaterThan(-210);
  });
});

describe("buildSeedPlan — spend guards", () => {
  it("refuses a plan whose quote deposit is below the non-dust floor", () => {
    // Tiny base + tiny price -> quote deposit under the 1 devUSDC floor.
    expect(() =>
      buildSeedPlan(params({ baseDepositRaw: 1_000n })),
    ).toThrow(/dust|minimum/i);
  });

  it("refuses when the wallet lacks enough base token", () => {
    expect(() =>
      buildSeedPlan(params({ available: { baseRaw: 1n, quoteRaw: 500_000_000n } })),
    ).toThrow(/insufficient/i);
  });

  it("refuses when the wallet lacks enough quote token", () => {
    expect(() =>
      buildSeedPlan(params({ available: { baseRaw: 5_000_000_000n, quoteRaw: 1n } })),
    ).toThrow(/insufficient/i);
  });

  it("only requires the un-seeded pools' balance when some are already seeded", () => {
    // Orca quote = 1e9 * 0.15 = 150M; both pools need 297M. Wallet covers
    // orca alone. Raydium already seeded -> only orca's deposit is required.
    expect(() =>
      buildSeedPlan(
        params({
          available: { baseRaw: 5_000_000_000n, quoteRaw: 150_000_000n },
          alreadySeeded: { raydium: true },
        }),
      ),
    ).not.toThrow();
  });

  it("still refuses when even the un-seeded pool's balance is short", () => {
    expect(() =>
      buildSeedPlan(
        params({
          available: { baseRaw: 5_000_000_000n, quoteRaw: 149_999_999n },
          alreadySeeded: { raydium: true },
        }),
      ),
    ).toThrow(/insufficient/i);
  });

  it("accepts a plan exactly at the available balance (boundary)", () => {
    const plan = buildSeedPlan(params());
    expect(() =>
      buildSeedPlan(
        params({
          available: {
            baseRaw: plan.totalBaseRaw,
            quoteRaw: plan.totalQuoteRaw,
          },
        }),
      ),
    ).not.toThrow();
  });
});
