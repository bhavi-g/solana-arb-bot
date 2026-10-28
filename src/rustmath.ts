/**
 * Thin FFI boundary to the `arb-math` Rust crate (ADR-0011, ADR-0012):
 * the on-chain minimum-out guard (src/txbuilder/index.ts) AND the
 * opportunity-detection decision (src/detect.ts's live call site in
 * main.ts) are both computed by a memory-safe Rust binary instead of TS,
 * invoked as a synchronous child process with a JSON request/response
 * contract over stdio. See rust/arb-math/src/main.rs for why amounts
 * cross as decimal strings rather than JSON numbers.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectParams } from "./detect.js";
import type { Decision, PoolSnapshot } from "./types.js";

const CRATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "rust",
  "arb-math",
);
const BIN_NAME =
  process.platform === "win32" ? "arb-math-cli.exe" : "arb-math-cli";
const BIN_PATH = path.join(CRATE_DIR, "target", "release", BIN_NAME);

/** Builds the release binary on first use if it isn't already there. */
function ensureBuilt(): void {
  if (existsSync(BIN_PATH)) return;
  execFileSync("cargo", ["build", "--release"], {
    cwd: CRATE_DIR,
    stdio: "inherit",
  });
  if (!existsSync(BIN_PATH)) {
    throw new Error(`arb-math-cli did not build at ${BIN_PATH}`);
  }
}

type SnapshotDto = {
  kind: "cpmm" | "whirlpool";
  dex: string;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  feeBps: number;
  baseReserve?: string;
  quoteReserve?: string;
  sqrtPriceX64?: string;
};

type RustRequest =
  | { op: "min_quote_out"; quote_in: string; min_profit_threshold: string }
  | {
      op: "cpmm_amount_out";
      amount_in: string;
      reserve_in: string;
      reserve_out: string;
      fee_bps: number;
    }
  | {
      op: "detect";
      a: SnapshotDto;
      b: SnapshotDto;
      tradeSizeQuote: string;
      minProfitThresholdQuote: string;
      slippageToleranceBps: number;
      estTxFeeQuote: string;
    };

/** Low-level call: runs the CLI and returns its parsed JSON, error or not. */
function callRustRaw(req: RustRequest): Record<string, unknown> {
  ensureBuilt();
  let out: string;
  try {
    out = execFileSync(BIN_PATH, [], {
      input: JSON.stringify(req),
      encoding: "utf8",
    });
  } catch (err) {
    // The CLI exits non-zero on a rejected request (e.g. overflow),
    // but still writes a well-formed {"error": "..."} line to stdout.
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      out = stdout;
    } else {
      throw err;
    }
  }
  return JSON.parse(out.trim()) as Record<string, unknown>;
}

function callRust(req: RustRequest): bigint {
  const res = callRustRaw(req);
  if ("error" in res) {
    throw new Error(`arb-math-cli: ${res.error as string}`);
  }
  return BigInt(res.result as string);
}

function snapshotToDto(s: PoolSnapshot): SnapshotDto {
  const base: SnapshotDto = {
    kind: s.kind,
    dex: s.dex,
    poolAddress: s.poolAddress,
    baseMint: s.pair.baseMint,
    quoteMint: s.pair.quoteMint,
    feeBps: s.feeBps,
  };
  return s.kind === "cpmm"
    ? { ...base, baseReserve: s.baseReserve.toString(), quoteReserve: s.quoteReserve.toString() }
    : { ...base, sqrtPriceX64: s.sqrtPriceX64.toString() };
}

/**
 * The atomic revert guard (ADR-0011): sell-leg minimum output is the
 * quote paid back plus the configured profit threshold.
 */
export function minQuoteOutViaRust(
  quoteIn: bigint,
  minProfitThreshold: bigint,
): bigint {
  return callRust({
    op: "min_quote_out",
    quote_in: quoteIn.toString(),
    min_profit_threshold: minProfitThreshold.toString(),
  });
}

/** Constant-product (x*y=k) swap output, fee on input — see math/cpmm.ts. */
export function cpmmAmountOutViaRust(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  return callRust({
    op: "cpmm_amount_out",
    amount_in: amountIn.toString(),
    reserve_in: reserveIn.toString(),
    reserve_out: reserveOut.toString(),
    fee_bps: feeBps,
  });
}

/**
 * Opportunity detection (ADR-0012): the full decision — both-direction
 * AMM math, fee/threshold comparison, gap-bps diagnostic — ported to
 * `rust/arb-math::detect`. `src/detect.ts` remains the tested reference
 * implementation (its 10 existing tests, and the parity suite in
 * tests/detect-rustmath.test.ts, which runs both against shared vectors);
 * this is what main.ts actually calls for the live decision.
 */
export function detectViaRust(
  a: PoolSnapshot,
  b: PoolSnapshot,
  p: DetectParams,
): Decision {
  const res = callRustRaw({
    op: "detect",
    a: snapshotToDto(a),
    b: snapshotToDto(b),
    tradeSizeQuote: p.tradeSizeQuote.toString(),
    minProfitThresholdQuote: p.minProfitThresholdQuote.toString(),
    slippageToleranceBps: p.slippageToleranceBps,
    estTxFeeQuote: p.estTxFeeQuote.toString(),
  });

  if ("error" in res) {
    throw new Error(`arb-math-cli: ${res.error as string}`);
  }

  if (res.decision === "no-opportunity") {
    return {
      decision: "no-opportunity",
      gapBps: res.gapBps as number,
      reason: res.reason as string,
    };
  }

  const direction = res.direction as Record<string, string>;
  return {
    decision: "opportunity",
    direction: {
      buyOn: direction.buyOn as PoolSnapshot["dex"],
      sellOn: direction.sellOn as PoolSnapshot["dex"],
      buyPoolAddress: direction.buyPoolAddress as string,
      sellPoolAddress: direction.sellPoolAddress as string,
    },
    gapBps: res.gapBps as number,
    quoteIn: BigInt(res.quoteIn as string),
    baseOut: BigInt(res.baseOut as string),
    quoteOut: BigInt(res.quoteOut as string),
    estNetProfit: BigInt(res.estNetProfit as string),
    minProfitThreshold: BigInt(res.minProfitThreshold as string),
  };
}
