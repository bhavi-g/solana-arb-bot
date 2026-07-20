import { describe, expect, it } from "vitest";
import { computeShadowStats } from "../src/stats.js";

const t0 = Date.parse("2026-07-17T00:00:00Z");
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60_000).toISOString();

function line(over: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: iso(0),
    cluster: "mainnet-beta",
    dataSource: "polling",
    slot: 1,
    gapBps: 0,
    decision: "no-opportunity",
    reason: "r",
    ...over,
  });
}

const shadow = (
  net: string | null,
  gross: string,
  offsetMin: number,
  err: unknown = null,
) =>
  line({
    timestamp: iso(offsetMin),
    decision: "opportunity",
    action: err === null ? "shadow-simulated" : "aborted-simulation-failed",
    simulation: { err },
    costs: {
      grossProfit: gross,
      baseFee: "900",
      priorityFee: net === null ? null : "150",
      jitoTip: "550000",
      jitoTipFraction: 0.55,
      netProfit: net,
      netComputable: net !== null,
    },
  });

describe("computeShadowStats", () => {
  const lines = [
    line({}), // no-opportunity cycle
    shadow("111450", "1000000", 10),
    shadow("-2000", "300000", 20),
    shadow(null, "500000", 30, { InstructionError: [0, "Custom"] }),
    line({ timestamp: iso(40), cluster: "devnet" }), // filtered out
  ];

  it("counts opportunities and rates over the observed window", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.totalRecords).toBe(4);
    expect(s.opportunities).toBe(3);
    expect(s.simFailures).toBe(1);
    expect(s.revertRate).toBeCloseTo(1 / 3);
    // window = first..last mainnet timestamp = 30 min → 0.5h
    expect(s.opportunitiesPerHour).toBeCloseTo(6);
  });

  it("separates gross-positive from NET-positive (the go/no-go signal)", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.grossPositive).toBe(3);
    expect(s.netPositive).toBe(1);
    expect(s.netPositiveRate).toBeCloseTo(1 / 3);
  });

  it("averages/medians use only computable values; bigint-safe", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.medianGross).toBe(500000n);
    expect(s.avgNet).toBe((111450n + -2000n) / 2n);
    // even count → mean of the two middles: (-2000 + 111450) / 2
    expect(s.medianNet).toBe(54725n);
  });

  it("applies since/until window filters", () => {
    const s = computeShadowStats(lines, {
      cluster: "mainnet-beta",
      sinceMs: t0 + 15 * 60_000,
    });
    expect(s.opportunities).toBe(2);
  });

  it("surfaces latency percentiles when detail.latency is present", () => {
    const withLatency = [
      line({ detail: { latency: { handoffMs: 100, detectComputeMs: 1 } } }),
      line({
        timestamp: iso(1),
        detail: { latency: { handoffMs: 900, detectComputeMs: 3 } },
      }),
    ];
    const s = computeShadowStats(withLatency, { cluster: "mainnet-beta" });
    expect(s.latency.handoffMsP50).toBe(100);
    expect(s.latency.handoffMsP95).toBe(900);
    expect(s.latency.detectComputeMsP50).toBe(1);
  });

  it("handles an empty window without dividing by zero", () => {
    const s = computeShadowStats([], {});
    expect(s.opportunities).toBe(0);
    expect(s.opportunitiesPerHour).toBe(0);
    expect(s.avgNet).toBeNull();
    expect(s.latency.handoffMsP50).toBeNull();
  });

  it("skips torn/non-JSON tail lines instead of throwing", () => {
    const s = computeShadowStats([...lines, '{"timestamp":"2026-'], {
      cluster: "mainnet-beta",
    });
    expect(s.opportunities).toBe(3);
  });
});
