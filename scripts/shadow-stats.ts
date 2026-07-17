/**
 * CLI over src/stats.ts: npx tsx scripts/shadow-stats.ts
 *   [--file logs/attempts.jsonl] [--cluster mainnet-beta] [--since 72h]
 */
import { readFileSync } from "node:fs";
import { computeShadowStats } from "../src/stats.js";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const file = arg("file", "logs/attempts.jsonl")!;
const cluster = arg("cluster", "mainnet-beta");
const since = arg("since");
const sinceMs = since
  ? Date.now() - Number(since.replace(/h$/, "")) * 3_600_000
  : undefined;

const lines = readFileSync(file, "utf8").split("\n");
const s = computeShadowStats(lines, {
  ...(cluster ? { cluster } : {}),
  ...(sinceMs !== undefined ? { sinceMs } : {}),
});

console.log(
  JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
);
