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
  cluster: string;
  rpcUrl: string;
  commitment: Commitment;
  keypairPath: string;
  dataSource: "polling" | "synthetic";
  tradeSizeQuote: bigint;
  minProfitThresholdQuote: bigint;
  slippageToleranceBps: number;
  maxRps: number;
  pollIntervalMs: number;
  /** Estimated tx fee converted to quote units, subtracted in detection. */
  estTxFeeQuote: bigint;
  raydiumProgramId: string;
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
  if (dataSource !== "polling" && dataSource !== "synthetic") {
    throw new ConfigError(
      `DATA_SOURCE must be "polling" or "synthetic", got "${dataSource}"`,
    );
  }
  if (dataSource === "polling") {
    const pollingKeys = [
      "RAYDIUM_POOL_ADDRESS",
      "ORCA_POOL_ADDRESS",
      "BASE_MINT",
      "QUOTE_MINT",
      "BASE_DECIMALS",
      "QUOTE_DECIMALS",
    ].filter((k) => !env[k]);
    if (pollingKeys.length > 0) {
      throw new ConfigError(
        `DATA_SOURCE=polling requires: ${pollingKeys.join(", ")}`,
      );
    }
  }

  const minProfitThresholdQuote = BigInt(env.MIN_PROFIT_THRESHOLD_QUOTE!);
  if (minProfitThresholdQuote < 0n) {
    throw new ConfigError(
      "MIN_PROFIT_THRESHOLD_QUOTE must be >= 0 (the threshold is never weakened)",
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
    cluster,
    rpcUrl,
    // ADR-0003: "processed" everywhere; not configurable on purpose.
    commitment: "processed",
    keypairPath: env.KEYPAIR_PATH!,
    dataSource,
    tradeSizeQuote: BigInt(env.TRADE_SIZE_QUOTE!),
    minProfitThresholdQuote,
    slippageToleranceBps: Number(env.SLIPPAGE_TOLERANCE_BPS),
    maxRps,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS),
    estTxFeeQuote: BigInt(env.EST_TX_FEE_QUOTE ?? "1000"),
    raydiumProgramId:
      env.RAYDIUM_CPMM_PROGRAM_ID ??
      RAYDIUM_CPMM_PROGRAM[cluster] ??
      RAYDIUM_CPMM_PROGRAM["devnet"]!,
    orcaProgramId: env.ORCA_WHIRLPOOL_PROGRAM_ID ?? ORCA_WHIRLPOOL_PROGRAM,
    ...(env.RAYDIUM_POOL_ADDRESS
      ? { raydiumPoolAddress: env.RAYDIUM_POOL_ADDRESS }
      : {}),
    ...(env.ORCA_POOL_ADDRESS ? { orcaPoolAddress: env.ORCA_POOL_ADDRESS } : {}),
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
