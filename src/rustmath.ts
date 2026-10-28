/**
 * Thin FFI boundary to the `arb-math` Rust crate (ADR-0011): the
 * on-chain minimum-out guard (src/txbuilder/index.ts) is computed by a
 * memory-safe, overflow-checked Rust binary instead of TS bigint
 * arithmetic, invoked as a synchronous child process with a JSON
 * request/response contract over stdio. See rust/arb-math/src/main.rs
 * for why amounts cross as decimal strings rather than JSON numbers.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

type RustRequest =
  | { op: "min_quote_out"; quote_in: string; min_profit_threshold: string }
  | {
      op: "cpmm_amount_out";
      amount_in: string;
      reserve_in: string;
      reserve_out: string;
      fee_bps: number;
    };

type RustResponse = { result: string } | { error: string };

function callRust(req: RustRequest): bigint {
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
  const res = JSON.parse(out.trim()) as RustResponse;
  if ("error" in res) {
    throw new Error(`arb-math-cli: ${res.error}`);
  }
  return BigInt(res.result);
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
