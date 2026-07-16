/**
 * Structured attempt logging (PROJECT_BRIEF: every attempt — successful,
 * aborted, reverted — is logged with timestamp, detected gap, simulated
 * result, sent-or-aborted, and why). One JSON line per attempt in
 * logs/attempts.jsonl plus a one-line console summary.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptRecord } from "./types.js";

export class AttemptLogger {
  constructor(private readonly filePath: string = "logs/attempts.jsonl") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  record(rec: AttemptRecord): void {
    appendFileSync(this.filePath, serialize(rec) + "\n");
    console.log(
      `[attempt] ${rec.timestamp} slot=${rec.slot} gap=${rec.gapBps}bps ` +
        `${rec.decision}${rec.action ? ` -> ${rec.action}` : ""} :: ${rec.reason}`,
    );
  }
}

/** JSON.stringify with bigint support (rendered as decimal strings). */
export function serialize(rec: AttemptRecord): string {
  return JSON.stringify(rec, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
