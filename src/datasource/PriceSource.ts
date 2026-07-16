/**
 * The swappable data-source boundary (ADR-0006). Detection, execution,
 * and logging consume this interface and never know what fills it.
 * Push-shaped on purpose: today's polling adapter pulls internally, but
 * WebSocket / Yellowstone gRPC adapters later are natively push and will
 * implement the same contract without touching downstream code.
 */
import type { PoolSnapshot } from "../types.js";

/** One detection cycle's input: fresh state for both watched pools. */
export interface SnapshotPair {
  cpmm: PoolSnapshot;
  whirlpool: PoolSnapshot;
}

export type SnapshotHandler = (pair: SnapshotPair) => void | Promise<void>;

export interface PriceSource {
  readonly name: string;
  /** Begin emitting snapshot pairs. Resolves when the source stops. */
  run(onPair: SnapshotHandler): Promise<void>;
  /** Request a graceful stop; run() resolves after the current cycle. */
  stop(): void;
}
