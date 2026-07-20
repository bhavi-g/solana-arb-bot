/**
 * Pure shadow-mode statistics over logs/attempts.jsonl lines (Phase 2 exit
 * data): opportunities/hour, gross vs NET positive rates (the Phase-3
 * go/no-go signal), revert rate, latency percentiles. Bigint-safe: profit
 * fields arrive as decimal strings from the logger's serializer.
 */

export interface StatsOptions {
  cluster?: string;
  sinceMs?: number;
  untilMs?: number;
}

export interface ShadowStats {
  windowStart: string | null;
  windowEnd: string | null;
  hours: number;
  totalRecords: number;
  opportunities: number;
  opportunitiesPerHour: number;
  grossPositive: number;
  netPositive: number;
  grossPositiveRate: number;
  netPositiveRate: number;
  avgGross: bigint | null;
  medianGross: bigint | null;
  avgNet: bigint | null;
  medianNet: bigint | null;
  simFailures: number;
  revertRate: number;
  latency: {
    handoffMsP50: number | null;
    handoffMsP95: number | null;
    detectComputeMsP50: number | null;
    detectComputeMsP95: number | null;
  };
}

interface ParsedRecord {
  timestamp: string;
  cluster: string;
  decision: string;
  action?: string;
  costs?: {
    grossProfit: string;
    netProfit: string | null;
    netComputable: boolean;
  };
  detail?: { latency?: { handoffMs: number; detectComputeMs: number } };
}

export function computeShadowStats(
  lines: string[],
  opts: StatsOptions = {},
): ShadowStats {
  const recs: ParsedRecord[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let rec: ParsedRecord;
    try {
      rec = JSON.parse(raw) as ParsedRecord;
    } catch {
      continue; // torn tail line from a live-appending process
    }
    const ts = Date.parse(rec.timestamp);
    if (opts.cluster && rec.cluster !== opts.cluster) continue;
    if (opts.sinceMs !== undefined && ts < opts.sinceMs) continue;
    if (opts.untilMs !== undefined && ts > opts.untilMs) continue;
    recs.push(rec);
  }

  const opportunities = recs.filter((r) => r.decision === "opportunity");
  const simFailures = opportunities.filter(
    (r) => r.action === "aborted-simulation-failed",
  ).length;

  const gross = opportunities
    .map((r) => r.costs?.grossProfit)
    .filter((g): g is string => g !== undefined)
    .map(BigInt);
  const net = opportunities
    .map((r) => (r.costs?.netComputable ? r.costs.netProfit : null))
    .filter((n): n is string => n !== null && n !== undefined)
    .map(BigInt);

  const first = recs[0] ? Date.parse(recs[0].timestamp) : null;
  const last = recs.length ? Date.parse(recs[recs.length - 1]!.timestamp) : null;
  const hours =
    first !== null && last !== null && last > first
      ? (last - first) / 3_600_000
      : 0;

  const handoffs = latencies(recs, "handoffMs");
  const detectMs = latencies(recs, "detectComputeMs");
  const grossPositive = gross.filter((g) => g > 0n).length;
  const netPositive = net.filter((n) => n > 0n).length;

  return {
    windowStart: recs[0]?.timestamp ?? null,
    windowEnd: recs.length ? recs[recs.length - 1]!.timestamp : null,
    hours,
    totalRecords: recs.length,
    opportunities: opportunities.length,
    opportunitiesPerHour: hours > 0 ? opportunities.length / hours : 0,
    grossPositive,
    netPositive,
    grossPositiveRate: rate(grossPositive, opportunities.length),
    netPositiveRate: rate(netPositive, opportunities.length),
    avgGross: avg(gross),
    medianGross: median(gross),
    avgNet: avg(net),
    medianNet: median(net),
    simFailures,
    revertRate: rate(simFailures, opportunities.length),
    latency: {
      handoffMsP50: percentile(handoffs, 50),
      handoffMsP95: percentile(handoffs, 95),
      detectComputeMsP50: percentile(detectMs, 50),
      detectComputeMsP95: percentile(detectMs, 95),
    },
  };
}

function latencies(
  recs: ParsedRecord[],
  key: "handoffMs" | "detectComputeMs",
): number[] {
  return recs
    .map((r) => r.detail?.latency?.[key])
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function avg(xs: bigint[]): bigint | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length) : null;
}

function median(xs: bigint[]): bigint | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
