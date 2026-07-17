/**
 * The single simulate-then-send gate (ADR-0005). This is the ONLY module
 * allowed to call sendRawTransaction; there is deliberately no other path
 * to submission anywhere in the codebase.
 *
 * Order of operations:
 *   1. build the transaction (no explicit CU limit yet)
 *   2. simulateTransaction — abort + log on any error
 *   3. re-check net profit >= threshold (defense in depth; the sell leg's
 *      min-out already makes an unprofitable trade FAIL simulation)
 *   4. rebuild with the CU budget MEASURED from simulation (+15% margin)
 *   5. send, logging sent/send-failed with the real signature or error
 *
 * Every outcome — aborted, sent, failed — writes an AttemptRecord.
 */
import type { AttemptLogger } from "./logger.js";
import type { AttemptRecord, Opportunity } from "./types.js";

/** Minimal structural slice of web3.js Connection used here (testable). */
export interface ExecutorRpc {
  simulateTransaction(
    tx: SerializableTx,
    config?: unknown,
  ): Promise<{
    context: { slot: number };
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  }>;
  sendRawTransaction(
    raw: Uint8Array,
    options?: unknown,
  ): Promise<string>;
}

export interface SerializableTx {
  serialize(): Uint8Array;
}

export type BuildTx = (computeUnitLimit?: number) => SerializableTx;

export interface ExecuteMeta {
  cluster: string;
  dataSource: string;
  slot: number;
  /** ADR-0008: when false the executor refuses to send, ever. */
  sendEnabled: boolean;
  /**
   * ADR-0009: caller-supplied cost model. Called with the would-send CU
   * limit (or null when simulation failed); result is attached to the
   * attempt record. Optional so Phase-1 style callers/tests are unchanged.
   */
  computeCosts?: (cuLimit: number | null) => NonNullable<AttemptRecord["costs"]>;
}

/** Thrown by the shadow-mode send transport: reaching it means layer 2 failed. */
export class SendDisabledError extends Error {}

const CU_MARGIN_NUM = 115n; // measured units + 15% headroom
const CU_MARGIN_DEN = 100n;

export async function execute(
  rpc: ExecutorRpc,
  buildTx: BuildTx,
  opp: Opportunity,
  logger: AttemptLogger,
  meta: ExecuteMeta,
): Promise<AttemptRecord> {
  const base = {
    cluster: meta.cluster,
    dataSource: meta.dataSource,
    slot: meta.slot,
    gapBps: opp.gapBps,
    decision: opp.decision,
    detail: {
      direction: opp.direction,
      quoteIn: opp.quoteIn,
      quoteOut: opp.quoteOut,
      estNetProfit: opp.estNetProfit,
      minProfitThreshold: opp.minProfitThreshold,
    },
  } as const;

  const finish = (rec: AttemptRecord): AttemptRecord => {
    logger.record(rec);
    return rec;
  };

  // Defense in depth: the threshold was already applied in detection, but
  // this gate re-checks it so no caller can bypass it (NEVER_DO.md).
  if (opp.estNetProfit < opp.minProfitThreshold) {
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "aborted-below-threshold",
      reason: `net profit ${opp.estNetProfit} below threshold ${opp.minProfitThreshold}`,
    });
  }

  const simTx = buildTx(undefined);
  const sim = await rpc.simulateTransaction(simTx, {
    commitment: "processed",
    replaceRecentBlockhash: true,
  });
  const simulation = {
    err: sim.value.err,
    ...(sim.value.unitsConsumed !== undefined
      ? { unitsConsumed: sim.value.unitsConsumed }
      : {}),
    logsTail: (sim.value.logs ?? []).slice(-5),
  };

  if (sim.value.err !== null) {
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "aborted-simulation-failed",
      simulation,
      ...(meta.computeCosts ? { costs: meta.computeCosts(null) } : {}),
      reason: `simulation returned an error: ${JSON.stringify(sim.value.err)}`,
    });
  }

  // Compute budget measured, not guessed (PROJECT_BRIEF execution rules).
  const measured = BigInt(sim.value.unitsConsumed ?? 200_000);
  const cuLimit = Number((measured * CU_MARGIN_NUM) / CU_MARGIN_DEN);

  // ADR-0008 layer 2: in shadow mode the send call below is unreachable.
  if (!meta.sendEnabled) {
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "shadow-simulated",
      simulation,
      ...(meta.computeCosts ? { costs: meta.computeCosts(cuLimit) } : {}),
      reason:
        `SHADOW: simulation passed (${measured} CU); would send with ` +
        `limit ${cuLimit} — send disabled (ADR-0008)`,
      detail: { ...base.detail, wouldSendCuLimit: cuLimit },
    });
  }

  const sendableTx = buildTx(cuLimit);

  try {
    const signature = await rpc.sendRawTransaction(sendableTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "processed",
    });
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "sent",
      simulation,
      signature,
      reason: `simulation passed (${measured} CU); sent with limit ${cuLimit}`,
    });
  } catch (e) {
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "send-failed",
      simulation,
      reason: `send failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
