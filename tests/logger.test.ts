import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttemptLogger, serialize } from "../src/logger.js";
import type { AttemptRecord } from "../src/types.js";

function rec(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    timestamp: "2026-07-16T00:00:00.000Z",
    cluster: "devnet",
    dataSource: "synthetic",
    slot: 3,
    gapBps: -300,
    decision: "opportunity",
    action: "aborted-simulation-failed",
    simulation: { err: { InstructionError: [0, "custom"] }, unitsConsumed: 12345 },
    reason: "simulation returned an error",
    ...overrides,
  };
}

describe("AttemptLogger", () => {
  it("appends one parseable JSON line per attempt, bigints as strings", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-log-"));
    const file = join(dir, "attempts.jsonl");
    const logger = new AttemptLogger(file);

    logger.record(rec());
    logger.record(
      rec({
        decision: "no-opportunity",
        detail: { estNetProfit: 249_998n },
        reason: "below threshold",
      }),
    );

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!);
    expect(first.action).toBe("aborted-simulation-failed");
    expect(first.simulation.unitsConsumed).toBe(12345);
    const second = JSON.parse(lines[1]!);
    expect(second.detail.estNetProfit).toBe("249998");
  });

  it("serialize handles every AttemptAction variant", () => {
    const actions = [
      "aborted-simulation-failed",
      "aborted-below-threshold",
      "sent",
      "send-failed",
    ] as const;
    for (const action of actions) {
      const parsed = JSON.parse(serialize(rec({ action })));
      expect(parsed.action).toBe(action);
    }
  });
});
