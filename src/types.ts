/**
 * Core domain types shared across data source, detection, execution, and
 * logging. Token amounts are always bigint in base units (lamports / token
 * atoms) — no floating point in money math.
 */

/** Which venue a snapshot came from. */
export type Dex = "raydium-cpmm" | "orca-whirlpool";

/** Identifies the trading pair; mints as base58 strings. */
export interface PairInfo {
  baseMint: string; // e.g. SOL
  quoteMint: string; // e.g. USDC
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Raw pool state at a moment in time. A tagged union: detection math needs
 * the raw state (reserves / sqrtPrice+liquidity), not a pre-computed price,
 * so price impact of a concrete trade size can be computed in one place
 * (see ADR-0006, Alternative 3).
 */
export type PoolSnapshot = CpmmSnapshot | WhirlpoolSnapshot;

export interface SnapshotBase {
  dex: Dex;
  poolAddress: string;
  pair: PairInfo;
  /** Unix ms when the underlying account data was fetched/emitted. */
  fetchedAtMs: number;
  /** Slot the data was observed at, when known (0 for synthetic). */
  slot: number;
  /** Which source produced this ("polling" | "synthetic" | future adapters). */
  source: string;
}

export interface CpmmSnapshot extends SnapshotBase {
  kind: "cpmm";
  /** Pool reserve of the base token, in base units. */
  baseReserve: bigint;
  /** Pool reserve of the quote token, in base units. */
  quoteReserve: bigint;
  /** Trade fee in basis points (e.g. 25 = 0.25%). */
  feeBps: number;
}

export interface WhirlpoolSnapshot extends SnapshotBase {
  kind: "whirlpool";
  /** Q64.64 sqrt price (token B per token A), as stored on-chain. */
  sqrtPriceX64: bigint;
  /** Active liquidity at the current tick. */
  liquidity: bigint;
  tickCurrentIndex: number;
  /** Trade fee in basis points. */
  feeBps: number;
}

/** Direction of an arbitrage: which pool we buy base on, which we sell on. */
export interface ArbDirection {
  buyOn: Dex;
  sellOn: Dex;
}

/** Result of evaluating a pair of snapshots. */
export type Decision = NoOpportunity | Opportunity;

export interface NoOpportunity {
  decision: "no-opportunity";
  /** Signed gap in basis points between the two venues' effective prices. */
  gapBps: number;
  reason: string;
}

export interface Opportunity {
  decision: "opportunity";
  direction: ArbDirection;
  gapBps: number;
  /** Quote-token amount spent on the buy leg (base units). */
  quoteIn: bigint;
  /** Base-token amount the buy leg yields (base units). */
  baseOut: bigint;
  /** Quote-token amount the sell leg yields (base units). */
  quoteOut: bigint;
  /** quoteOut - quoteIn - estimated fees, in quote base units. */
  estNetProfit: bigint;
  /** Threshold the profit cleared, recorded for the log. */
  minProfitThreshold: bigint;
}

/** What the executor actually did with an opportunity. */
export type AttemptAction =
  | "aborted-simulation-failed"
  | "aborted-below-threshold"
  | "sent"
  | "send-failed";

/** One line in logs/attempts.jsonl — every attempt, no exceptions. */
export interface AttemptRecord {
  timestamp: string; // ISO 8601
  cluster: string;
  dataSource: string;
  slot: number;
  gapBps: number;
  decision: Decision["decision"];
  action?: AttemptAction;
  /** Real simulateTransaction output summary; never fabricated. */
  simulation?: {
    err: unknown;
    unitsConsumed?: number;
    logsTail?: string[];
  };
  signature?: string;
  reason: string;
  detail?: Record<string, unknown>;
}
