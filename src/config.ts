/**
 * All runtime configuration comes from the environment (.env), per
 * ADR-0004: devnet vs mainnet is a config switch, never a code fork.
 * The one piece of cluster-awareness allowed here is a VALIDATION rule:
 * Phase 1 refuses to start against mainnet (docs/NEVER_DO.md line 1).
 */
import type { Commitment } from "@solana/web3.js";

export type Env = Record<string, string | undefined>;

export interface Config {
  phase: number;
  /**
   * Derived, never read from the environment (ADR-0008). False whenever
   * PHASE=2 (shadow mode). PHASE>=3 refuses to start entirely — live
   * sending does not exist in this version of the codebase.
   */
  sendEnabled: boolean;
  cluster: string;
  rpcUrl: string;
  commitment: Commitment;
  keypairPath: string;
  dataSource: "polling" | "synthetic" | "geyser";
  /**
   * Which two venues to arbitrage between. "cpmm-orca" (default) is
   * Raydium CPMM vs Orca Whirlpool. "orca-orca" is two Orca Whirlpools at
   * different fee tiers — the Phase-2 interim venue (docs/phases/
   * phase-2-mainnet-shadow-mode.md) while a Raydium CLMM decoder is built.
   */
  venue: "cpmm-orca" | "orca-orca" | "clmm-orca";
  orcaPoolAddressB?: string;
  /** Raydium CLMM pool address (VENUE=clmm-orca). */
  clmmPoolAddress?: string;
  tradeSizeQuote: bigint;
  minProfitThresholdQuote: bigint;
  slippageToleranceBps: number;
  maxRps: number;
  pollIntervalMs: number;
  /**
   * Manual override for the estimated tx fee in quote units (ADR-0007).
   * When set, it is used verbatim and the live fetch/convert is skipped.
   * When undefined, main.ts derives the fee from a real getFeeForMessage
   * call plus per-cycle mid-price conversion — this is the normal path.
   */
  estTxFeeQuote?: bigint;
  /**
   * Modeled Jito tip fraction of gross profit, in basis points (ADR-0009).
   * Accounting only — no tip is ever constructed, paid, or sent in Phase 2.
   * Owner-approved band: 5000–6000 bps (0.50–0.60). Default 5500.
   */
  jitoTipFractionBps: number;
  /**
   * Shadow-mode simulation owner (a live-discovered funded mainnet wallet,
   * see scripts/find-surrogate.ts). Shadow builds are UNSIGNED with this
   * owner's ATAs so simulation reflects the strategy, not our unfunded
   * wallet. Read-only borrowing: nothing is ever sent.
   */
  surrogateOwner?: string;
  /**
   * Yellowstone Geyser gRPC endpoint (DATA_SOURCE=geyser). Code-complete
   * but NOT runnable until the owner provides one — Geyser is not on the
   * Helius free tier and procurement is a stop-and-ask money item.
   */
  geyserEndpoint?: string;
  geyserXToken?: string;
  raydiumProgramId: string;
  /**
   * Raydium CLMM program id (VENUE=clmm-orca) — a DISTINCT program from the
   * CPMM raydiumProgramId. Default mainnet CAMMCzo…; override with
   * RAYDIUM_CLMM_PROGRAM_ID.
   */
  raydiumClmmProgramId: string;
  orcaProgramId: string;
  raydiumPoolAddress?: string;
  orcaPoolAddress?: string;
  baseMint?: string;
  quoteMint?: string;
  baseDecimals?: number;
  quoteDecimals?: number;
}

/**
 * Default program IDs per cluster — reference data, not behavior
 * (overridable via RAYDIUM_CPMM_PROGRAM_ID / ORCA_WHIRLPOOL_PROGRAM_ID).
 * The Whirlpool program uses the same address on devnet and mainnet.
 */
// Devnet CPMM program per docs.raydium.io/reference/program-addresses
const RAYDIUM_CPMM_PROGRAM: Record<string, string> = {
  devnet: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  "mainnet-beta": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
};
const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
// Raydium CLMM program (same address devnet/mainnet per docs.raydium.io).
const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

const HELIUS_FREE_TIER_RPS = 10;

class ConfigError extends Error {}

export function loadConfig(env: Env): Config {
  const required = [
    "PHASE",
    "CLUSTER",
    "KEYPAIR_PATH",
    "DATA_SOURCE",
    "TRADE_SIZE_QUOTE",
    "MIN_PROFIT_THRESHOLD_QUOTE",
    "SLIPPAGE_TOLERANCE_BPS",
    "MAX_RPS",
    "POLL_INTERVAL_MS",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required config keys: ${missing.join(", ")} — see .env.example`,
    );
  }

  const phase = Number(env.PHASE);
  const cluster = env.CLUSTER!;

  // ADR-0008: sending is derived from PHASE and cannot be switched on.
  if (env.SEND_ENABLED !== undefined) {
    throw new ConfigError(
      "SEND_ENABLED is not a switch that exists: sending is derived from " +
        "PHASE and cannot be enabled by configuration (ADR-0008).",
    );
  }
  if (phase >= 3) {
    throw new ConfigError(
      `PHASE=${phase}: Phase 3+ (live mainnet sending) is not implemented ` +
        "in this version of the codebase. Enabling it requires a code " +
        "change plus an ADR (ADR-0008).",
    );
  }

  const rpcUrl =
    env.RPC_URL ??
    (env.HELIUS_API_KEY
      ? heliusUrl(cluster, env.HELIUS_API_KEY)
      : undefined);
  if (!rpcUrl) {
    throw new ConfigError(
      "No RPC source configured: set RPC_URL or HELIUS_API_KEY",
    );
  }

  // NEVER_DO.md: "NEVER connect to mainnet in Phase 1. Devnet only."
  // Validation of config data, not a forked code path (ADR-0004).
  if (phase < 2 && (cluster.includes("mainnet") || rpcUrl.includes("mainnet"))) {
    throw new ConfigError(
      `Refusing to start: cluster/RPC points at mainnet but PHASE=${phase}. ` +
        "Mainnet is forbidden in Phase 1 (docs/NEVER_DO.md).",
    );
  }

  const dataSource = env.DATA_SOURCE!;
  if (
    dataSource !== "polling" &&
    dataSource !== "synthetic" &&
    dataSource !== "geyser"
  ) {
    throw new ConfigError(
      `DATA_SOURCE must be "polling", "synthetic", or "geyser", got "${dataSource}"`,
    );
  }
  if (dataSource === "geyser" && !env.GEYSER_ENDPOINT) {
    throw new ConfigError(
      "DATA_SOURCE=geyser requires GEYSER_ENDPOINT (owner decision: " +
        "endpoint procurement is deferred — this source is code-complete " +
        "but not runnable until an endpoint exists)",
    );
  }
  const venue = env.VENUE ?? "cpmm-orca";
  if (venue !== "cpmm-orca" && venue !== "orca-orca" && venue !== "clmm-orca") {
    throw new ConfigError(
      `VENUE must be "cpmm-orca", "orca-orca", or "clmm-orca", got "${venue}"`,
    );
  }

  if (dataSource === "polling" || dataSource === "geyser") {
    const venueKeys =
      venue === "orca-orca"
        ? ["ORCA_POOL_ADDRESS", "ORCA_POOL_ADDRESS_B"]
        : venue === "clmm-orca"
          ? ["RAYDIUM_CLMM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"]
          : ["RAYDIUM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"];
    const pollingKeys = [
      ...venueKeys,
      "BASE_MINT",
      "QUOTE_MINT",
      "BASE_DECIMALS",
      "QUOTE_DECIMALS",
    ].filter((k) => !env[k]);
    if (pollingKeys.length > 0) {
      throw new ConfigError(
        `DATA_SOURCE=${dataSource} VENUE=${venue} requires: ${pollingKeys.join(", ")}`,
      );
    }
  }

  const minProfitThresholdQuote = BigInt(env.MIN_PROFIT_THRESHOLD_QUOTE!);
  if (minProfitThresholdQuote < 0n) {
    throw new ConfigError(
      "MIN_PROFIT_THRESHOLD_QUOTE must be >= 0 (the threshold is never weakened)",
    );
  }

  const jitoTipFraction = env.JITO_TIP_FRACTION
    ? Number(env.JITO_TIP_FRACTION)
    : 0.55;
  if (
    !Number.isFinite(jitoTipFraction) ||
    jitoTipFraction < 0.5 ||
    jitoTipFraction > 0.6
  ) {
    throw new ConfigError(
      "JITO_TIP_FRACTION must be a number between 0.50 and 0.60 (ADR-0009)",
    );
  }

  const maxRps = Number(env.MAX_RPS);
  if (!Number.isFinite(maxRps) || maxRps <= 0 || maxRps > HELIUS_FREE_TIER_RPS) {
    throw new ConfigError(
      `MAX_RPS must be in (0, ${HELIUS_FREE_TIER_RPS}] — Helius free tier is ${HELIUS_FREE_TIER_RPS} req/s`,
    );
  }

  return {
    phase,
    sendEnabled: phase < 2,
    cluster,
    rpcUrl,
    // ADR-0003: "processed" everywhere; not configurable on purpose.
    commitment: "processed",
    keypairPath: env.KEYPAIR_PATH!,
    dataSource,
    venue,
    tradeSizeQuote: BigInt(env.TRADE_SIZE_QUOTE!),
    minProfitThresholdQuote,
    slippageToleranceBps: Number(env.SLIPPAGE_TOLERANCE_BPS),
    maxRps,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS),
    // ADR-0007: no static default. Only carried through when explicitly set
    // as an override; otherwise the fee is fetched + repriced live at runtime.
    ...(env.EST_TX_FEE_QUOTE
      ? { estTxFeeQuote: BigInt(env.EST_TX_FEE_QUOTE) }
      : {}),
    jitoTipFractionBps: Math.round(jitoTipFraction * 10_000),
    ...(env.SURROGATE_OWNER ? { surrogateOwner: env.SURROGATE_OWNER } : {}),
    ...(env.GEYSER_ENDPOINT ? { geyserEndpoint: env.GEYSER_ENDPOINT } : {}),
    ...(env.GEYSER_X_TOKEN ? { geyserXToken: env.GEYSER_X_TOKEN } : {}),
    raydiumProgramId:
      env.RAYDIUM_CPMM_PROGRAM_ID ??
      RAYDIUM_CPMM_PROGRAM[cluster] ??
      RAYDIUM_CPMM_PROGRAM["devnet"]!,
    orcaProgramId: env.ORCA_WHIRLPOOL_PROGRAM_ID ?? ORCA_WHIRLPOOL_PROGRAM,
    raydiumClmmProgramId: env.RAYDIUM_CLMM_PROGRAM_ID ?? RAYDIUM_CLMM_PROGRAM,
    ...(env.RAYDIUM_POOL_ADDRESS
      ? { raydiumPoolAddress: env.RAYDIUM_POOL_ADDRESS }
      : {}),
    ...(env.ORCA_POOL_ADDRESS ? { orcaPoolAddress: env.ORCA_POOL_ADDRESS } : {}),
    ...(env.ORCA_POOL_ADDRESS_B ? { orcaPoolAddressB: env.ORCA_POOL_ADDRESS_B } : {}),
    ...(env.RAYDIUM_CLMM_POOL_ADDRESS
      ? { clmmPoolAddress: env.RAYDIUM_CLMM_POOL_ADDRESS }
      : {}),
    ...(env.BASE_MINT ? { baseMint: env.BASE_MINT } : {}),
    ...(env.QUOTE_MINT ? { quoteMint: env.QUOTE_MINT } : {}),
    ...(env.BASE_DECIMALS ? { baseDecimals: Number(env.BASE_DECIMALS) } : {}),
    ...(env.QUOTE_DECIMALS ? { quoteDecimals: Number(env.QUOTE_DECIMALS) } : {}),
  };
}

function heliusUrl(cluster: string, apiKey: string): string {
  const sub = cluster === "devnet" ? "devnet" : "mainnet";
  return `https://${sub}.helius-rpc.com/?api-key=${apiKey}`;
}
