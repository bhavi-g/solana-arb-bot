# Phase 2 Mainnet Shadow Mode Implementation Plan


**Goal:** Run detection against real mainnet SOL/USDC pool state with the send path structurally disabled, logging every opportunity with a full realistic cost breakdown (gross AND net), plus stats tooling and a code-only Geyser gRPC source.

**Architecture:** Three independent send-disable layers (config-derived `sendEnabled`, executor-internal refusal, null send transport in wiring). A pure cost module converts measured CU + live CU price + modeled Jito tip into net profit. Surrogate-owner unsigned transactions make mainnet simulation real without funding anything. All new data-source work stays behind the existing `PriceSource` interface (ADR-0006).

**Tech Stack:** TypeScript, @solana/web3.js 1.98.4, vitest, tsx. New devDependency in Task 7 only: `@triton-one/yellowstone-grpc` (exact-pinned).

**Spec:** `docs/design/specs/2026-07-17-phase-2-mainnet-shadow-mode-design.md` (owner-approved).

## Global Constraints

- NEVER submit a real mainnet transaction. No exceptions; this whole plan exists to make that structural.
- Do not edit the owner's `.env`; pass Phase-2 config as process env vars on the command line. `.env.example` is the documented template.
- No real money without owner approval: no RPC tier upgrades, no wallet funding, no Geyser endpoint procurement. Helius free tier only (`MAX_RPS ≤ 10` already enforced).
- All new dependencies exact-pinned (no `^`), matching `package.json` convention.
- All money math in bigint base units; no floats in profit calculations (floats allowed only for rates/latencies in stats output).
- Never fabricate simulation output or addresses; discover mainnet addresses live via the probe script.
- `npm test` and `npm run typecheck` must be green before every commit.
- Commit format: `T<n>: <summary>` continuing the repo sequence (next is T27), with the standard co-author trailer.
- If the mainnet Raydium CPMM SOL/USDC pool has quote reserves below 100,000 USDC (base units 100_000_000_000), STOP and ask the owner (Decision 6) — do not proceed to the shadow run, do not build a CLMM decoder, do not fall back to Orca-only.

---

### Task 1: Config layer — derived `sendEnabled`, PHASE≥3 refusal, SEND_ENABLED tripwire

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: existing `loadConfig(env)` / `Config`.
- Produces: `Config.sendEnabled: boolean` (true only when `phase < 2`); `loadConfig` throws on `PHASE >= 3` and on any `SEND_ENABLED` env var. Tasks 2–5 read `cfg.sendEnabled`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
describe("sendEnabled derivation (ADR-0008 structural send-disable)", () => {
  const shadowEnv = (over: Record<string, string> = {}) => ({
    PHASE: "2",
    CLUSTER: "mainnet-beta",
    RPC_URL: "https://rpc.example.com",
    KEYPAIR_PATH: "keypairs/mainnet-shadow.json",
    DATA_SOURCE: "synthetic",
    TRADE_SIZE_QUOTE: "10000000",
    MIN_PROFIT_THRESHOLD_QUOTE: "10000",
    SLIPPAGE_TOLERANCE_BPS: "50",
    MAX_RPS: "8",
    POLL_INTERVAL_MS: "1000",
    ...over,
  });

  it("PHASE=2 on mainnet loads (guard is phase<2 only) with sendEnabled=false", () => {
    const cfg = loadConfig(shadowEnv());
    expect(cfg.sendEnabled).toBe(false);
  });

  it("PHASE=2 is shadow even on devnet", () => {
    const cfg = loadConfig(
      shadowEnv({ CLUSTER: "devnet", RPC_URL: "https://api.devnet.solana.com" }),
    );
    expect(cfg.sendEnabled).toBe(false);
  });

  it("PHASE=1 devnet keeps sendEnabled=true (Phase 1 behavior unchanged)", () => {
    const cfg = loadConfig(
      shadowEnv({ PHASE: "1", CLUSTER: "devnet", RPC_URL: "https://api.devnet.solana.com" }),
    );
    expect(cfg.sendEnabled).toBe(true);
  });

  it("PHASE=3 refuses to start: live sending is not implemented", () => {
    expect(() => loadConfig(shadowEnv({ PHASE: "3" }))).toThrow(/not implemented/i);
  });

  it("any SEND_ENABLED env var is rejected — no such switch exists", () => {
    expect(() => loadConfig(shadowEnv({ SEND_ENABLED: "true" }))).toThrow(/no such switch|not a switch/i);
    expect(() => loadConfig(shadowEnv({ SEND_ENABLED: "false" }))).toThrow(/no such switch|not a switch/i);
  });
});
```

(Reuse the file's existing imports; add none.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/config.test.ts`
Expected: the 5 new tests FAIL (`sendEnabled` undefined; PHASE=3 / SEND_ENABLED do not throw).

- [ ] **Step 3: Implement in `src/config.ts`**

Add to the `Config` interface after `phase: number;`:

```ts
  /**
   * Derived, never read from the environment (ADR-0008). False whenever
   * PHASE=2 (shadow mode). PHASE>=3 refuses to start entirely — live
   * sending does not exist in this version of the codebase.
   */
  sendEnabled: boolean;
```

In `loadConfig`, immediately after `const cluster = env.CLUSTER!;`:

```ts
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
```

In the returned object, after `phase,`:

```ts
    sendEnabled: phase < 2,
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (89 prior + 5 new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "T27: config-derived sendEnabled; PHASE>=3 and SEND_ENABLED refusals (ADR-0008 layer 1)"
```

---

### Task 2: Executor shadow mode + null send transport + banner

**Files:**
- Modify: `src/types.ts` (add `"shadow-simulated"` action)
- Modify: `src/executor.ts` (`ExecuteMeta.sendEnabled`, shadow branch, `SendDisabedError` — spelled `SendDisabledError`)
- Modify: `src/main.ts` (banner, null transport, pass `sendEnabled` in meta)
- Test: `tests/executor.test.ts`

**Interfaces:**
- Consumes: `Config.sendEnabled` (Task 1).
- Produces: `ExecuteMeta.sendEnabled: boolean` (required field — every caller must decide); `AttemptAction "shadow-simulated"`; `export class SendDisabledError extends Error {}` from `src/executor.ts`. Task 3 extends the same shadow branch with costs.

- [ ] **Step 1: Write the failing tests**

In `tests/executor.test.ts`, change the shared meta to
`const meta = { cluster: "devnet", dataSource: "synthetic", slot: 3, sendEnabled: true };`
and append:

```ts
describe("shadow mode (ADR-0008 layer 2: executor refuses to send)", () => {
  const shadowMeta = { ...meta, cluster: "mainnet-beta", sendEnabled: false };

  it("simulates, logs shadow-simulated, and NEVER calls send — even when profitable", async () => {
    const { rpc, sendSpy, simulateSpy } = makeRpc({ unitsConsumed: 100_000 });
    const { buildTx, builds } = fakeBuildTx();
    const { logger, file } = tempLogger();

    const result = await execute(rpc, buildTx, opp, logger, shadowMeta);

    expect(simulateSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(result.action).toBe("shadow-simulated");
    expect(builds.length).toBe(1); // no second (sendable) build in shadow

    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.action).toBe("shadow-simulated");
    expect(line.simulation.unitsConsumed).toBe(100_000);
    expect(line.reason).toMatch(/shadow/i);
    expect(line.detail.wouldSendCuLimit).toBeGreaterThanOrEqual(100_000);
  });

  it("still logs aborted-simulation-failed on sim error (revert-rate signal)", async () => {
    const { rpc, sendSpy } = makeRpc({ err: { InstructionError: [0, { Custom: 1 }] } });
    const { buildTx } = fakeBuildTx();
    const { logger } = tempLogger();
    const result = await execute(rpc, buildTx, opp, logger, shadowMeta);
    expect(result.action).toBe("aborted-simulation-failed");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("still enforces the threshold in shadow mode", async () => {
    const { rpc, sendSpy } = makeRpc();
    const { buildTx } = fakeBuildTx();
    const { logger } = tempLogger();
    const result = await execute(
      rpc, buildTx, { ...opp, estNetProfit: 0n }, logger, shadowMeta,
    );
    expect(result.action).toBe("aborted-below-threshold");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/executor.test.ts`
Expected: FAIL — typecheck/compile error on `sendEnabled` (not in `ExecuteMeta`), then behavior failures.

- [ ] **Step 3: Implement**

`src/types.ts` — extend the union:

```ts
export type AttemptAction =
  | "aborted-simulation-failed"
  | "aborted-below-threshold"
  | "shadow-simulated"
  | "sent"
  | "send-failed";
```

`src/executor.ts` — add to `ExecuteMeta`:

```ts
export interface ExecuteMeta {
  cluster: string;
  dataSource: string;
  slot: number;
  /** ADR-0008: when false the executor refuses to send, ever. */
  sendEnabled: boolean;
}
```

Add near `ExecutorRpc`:

```ts
/** Thrown by the shadow-mode send transport: reaching it means layer 2 failed. */
export class SendDisabledError extends Error {}
```

In `execute`, after `const cuLimit = Number(...)` and BEFORE `const sendableTx = buildTx(cuLimit);`, insert:

```ts
  // ADR-0008 layer 2: in shadow mode the send call below is unreachable.
  if (!meta.sendEnabled) {
    return finish({
      ...base,
      timestamp: new Date().toISOString(),
      action: "shadow-simulated",
      simulation,
      reason:
        `SHADOW: simulation passed (${measured} CU); would send with ` +
        `limit ${cuLimit} — send disabled (ADR-0008)`,
      detail: { ...base.detail, wouldSendCuLimit: cuLimit },
    });
  }
```

`src/main.ts` — after the wallet log line add:

```ts
  if (!cfg.sendEnabled) {
    console.log(
      "[main] SHADOW MODE — send path structurally disabled (ADR-0008); " +
        "no real transaction will be submitted",
    );
  }
```

Replace `sendRawTransaction` in `gatedRpc` (ADR-0008 layer 3 — the real capability is never constructed in shadow mode):

```ts
    sendRawTransaction: cfg.sendEnabled
      ? async (raw, options) => {
          await limiter.acquire();
          return connection.sendRawTransaction(
            raw,
            options as Parameters<Connection["sendRawTransaction"]>[1],
          );
        }
      : async () => {
          throw new SendDisabledError(
            "sendRawTransaction invoked in shadow mode — the executor's " +
              "layer-2 guard was bypassed (ADR-0008)",
          );
        },
```

Import `SendDisabledError` alongside `execute` and pass the flag in the execute call's meta:
`{ cluster: cfg.cluster, dataSource: source.name, slot: pair.cpmm.slot, sendEnabled: cfg.sendEnabled }`.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS (existing executor tests unchanged apart from the meta field), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/executor.ts src/main.ts tests/executor.test.ts
git commit -m "T28: shadow-simulated executor branch + null send transport (ADR-0008 layers 2+3)"
```

---

### Task 3: Realistic cost model (`src/costs.ts`) + costs on every shadow record

**Files:**
- Create: `src/costs.ts`
- Modify: `src/types.ts` (AttemptRecord `costs` block), `src/config.ts` (`jitoTipFractionBps`), `src/executor.ts` (optional `computeCosts` hook), `src/main.ts` (CU-price cache + wiring), `.env.example` (JITO_TIP_FRACTION)
- Test: `tests/costs.test.ts` (new), `tests/executor.test.ts` (hook), `tests/config.test.ts` (fraction parsing)

**Interfaces:**
- Consumes: `lamportsFeeToQuote(feeLamports, priceRef)` from `src/fee.ts`; `PoolSnapshot`.
- Produces:
  - `computeCosts(inp: CostInputs, cuLimit: number | null): CostBreakdown`
  - `medianCuPriceMicroLamports(fees: ReadonlyArray<{ prioritizationFee: number }>): bigint`
  - `DEFAULT_CU_PRICE_MICRO_LAMPORTS = 1_000n`
  - `Config.jitoTipFractionBps: number` (default 5500; env `JITO_TIP_FRACTION` ∈ [0.50, 0.60])
  - `ExecuteMeta.computeCosts?: (cuLimit: number | null) => CostBreakdown`
  - `AttemptRecord.costs?: CostBreakdown`
  - Task 6 (stats) parses the serialized `costs` block: bigints as decimal strings, `netProfit` possibly `null`, `netComputable` boolean.

- [ ] **Step 1: Write the failing tests (`tests/costs.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import {
  computeCosts,
  medianCuPriceMicroLamports,
  DEFAULT_CU_PRICE_MICRO_LAMPORTS,
  type CostInputs,
} from "../src/costs.js";
import type { PoolSnapshot } from "../src/types.js";

// CPMM priceRef: 150,000 USDC (6dp) / 1,000 SOL (9dp) => price via
// midPriceNum/Den = quoteReserve/baseReserve = 0.00015 quote-units per lamport.
const priceRef: PoolSnapshot = {
  kind: "cpmm",
  dex: "raydium-cpmm",
  poolAddress: "P",
  pair: { baseMint: "b", quoteMint: "q", baseDecimals: 9, quoteDecimals: 6 },
  fetchedAtMs: 0,
  slot: 1,
  source: "test",
  baseReserve: 1_000_000_000_000n, // 1,000 SOL in lamports
  quoteReserve: 150_000_000_000n, // 150,000 USDC in base units
  feeBps: 25,
};

const inputs: CostInputs = {
  grossProfitQuote: 1_000_000n, // 1 USDC gross
  baseFeeQuote: 900n, // ADR-0007 quote-converted base fee (headroom included)
  cuPriceMicroLamports: 5_000n,
  jitoTipFractionBps: 5_500,
  priceRef,
};

describe("computeCosts", () => {
  it("computes priority fee from cuLimit × cuPrice (ceil), converted to quote", () => {
    // 200_000 CU × 5_000 μlam = 1e9 μlam = 1_000 lamports
    // → quote: 1_000 × 150_000_000_000 / 1_000_000_000_000 = 150
    const c = computeCosts(inputs, 200_000);
    expect(c.priorityFee).toBe(150n);
  });

  it("rounds the priority fee UP (never underestimates a cost)", () => {
    // 1 CU × 5_000 μlam = 5_000 μlam = 0.005 lamports → ceil to 1 lamport
    const c = computeCosts(inputs, 1);
    // 1 lamport → 150_000_000_000/1_000_000_000_000 = 0.15 → floor 0... must be ≥ 0
    expect(c.priorityFee).toBe(0n); // sub-unit quote conversion floors; lamports ceil
  });

  it("models the Jito tip as tipFractionBps of POSITIVE gross profit", () => {
    const c = computeCosts(inputs, 200_000);
    expect(c.jitoTip).toBe(550_000n); // 55% of 1_000_000
    expect(c.jitoTipFraction).toBeCloseTo(0.55);
  });

  it("no tip on zero/negative gross", () => {
    const c = computeCosts({ ...inputs, grossProfitQuote: -5n }, 200_000);
    expect(c.jitoTip).toBe(0n);
  });

  it("netProfit = gross − baseFee − priorityFee − jitoTip", () => {
    const c = computeCosts(inputs, 200_000);
    expect(c.netProfit).toBe(1_000_000n - 900n - 150n - 550_000n);
    expect(c.netComputable).toBe(true);
  });

  it("cuLimit=null (sim failed): net is uncomputable, never fabricated", () => {
    const c = computeCosts(inputs, null);
    expect(c.priorityFee).toBeNull();
    expect(c.netProfit).toBeNull();
    expect(c.netComputable).toBe(false);
    expect(c.grossProfit).toBe(1_000_000n); // gross still reported
  });
});

describe("medianCuPriceMicroLamports", () => {
  it("returns the median of positive samples (zeros filtered — conservative)", () => {
    const fees = [0, 0, 100, 500, 9000].map((prioritizationFee) => ({ prioritizationFee }));
    expect(medianCuPriceMicroLamports(fees)).toBe(500n);
  });
  it("falls back to the documented default when no positive samples", () => {
    expect(medianCuPriceMicroLamports([])).toBe(DEFAULT_CU_PRICE_MICRO_LAMPORTS);
    expect(medianCuPriceMicroLamports([{ prioritizationFee: 0 }])).toBe(
      DEFAULT_CU_PRICE_MICRO_LAMPORTS,
    );
  });
});
```

Executor hook test — append inside the shadow-mode describe in `tests/executor.test.ts`:

```ts
  it("attaches the caller's cost breakdown to shadow records", async () => {
    const { rpc } = makeRpc({ unitsConsumed: 100_000 });
    const { buildTx } = fakeBuildTx();
    const { logger, file } = tempLogger();
    const computeCosts = vi.fn((cuLimit: number | null) => ({
      grossProfit: 250_000n,
      baseFee: 900n,
      priorityFee: cuLimit === null ? null : 150n,
      jitoTip: 137_500n,
      jitoTipFraction: 0.55,
      netProfit: cuLimit === null ? null : 111_450n,
      netComputable: cuLimit !== null,
    }));

    await execute(rpc, buildTx, opp, logger, { ...shadowMeta, computeCosts });

    expect(computeCosts).toHaveBeenCalledWith(expect.any(Number));
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.costs.grossProfit).toBe("250000");
    expect(line.costs.netProfit).toBe("111450");
  });

  it("passes cuLimit=null to the cost hook when simulation fails", async () => {
    const { rpc } = makeRpc({ err: "Reverted" });
    const { buildTx } = fakeBuildTx();
    const { logger, file } = tempLogger();
    const computeCosts = vi.fn((cuLimit: number | null) => ({
      grossProfit: 250_000n, baseFee: 900n, priorityFee: null,
      jitoTip: 137_500n, jitoTipFraction: 0.55, netProfit: null,
      netComputable: false,
    }));
    await execute(rpc, buildTx, opp, logger, { ...shadowMeta, computeCosts });
    expect(computeCosts).toHaveBeenCalledWith(null);
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.costs.netComputable).toBe(false);
  });
```

Config test — append to the ADR-0008 describe in `tests/config.test.ts`:

```ts
  it("JITO_TIP_FRACTION defaults to 0.55 and must stay in [0.50, 0.60]", () => {
    expect(loadConfig(shadowEnv()).jitoTipFractionBps).toBe(5500);
    expect(loadConfig(shadowEnv({ JITO_TIP_FRACTION: "0.6" })).jitoTipFractionBps).toBe(6000);
    expect(() => loadConfig(shadowEnv({ JITO_TIP_FRACTION: "0.45" }))).toThrow(/0\.50/);
    expect(() => loadConfig(shadowEnv({ JITO_TIP_FRACTION: "abc" }))).toThrow(/0\.50/);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/costs.test.ts tests/executor.test.ts tests/config.test.ts`
Expected: FAIL (`src/costs.ts` missing; hook/field missing).

- [ ] **Step 3: Implement**

Create `src/costs.ts`:

```ts
/**
 * Realistic cost model (ADR-0009). Turns a detected opportunity plus
 * simulation data into a fully-costed record with BOTH gross and net.
 *
 * grossProfit = quoteOut − quoteIn from the real AMM curve math on both
 * legs. Pool fees, price impact, and slippage are ALREADY inside that
 * number — they are how the curve prices each swap — so they are not
 * separate subtractions here. The explicit subtractions are the costs the
 * curve cannot see: base tx fee (ADR-0007), priority fee (measured CU ×
 * live CU price), and a MODELED Jito tip (accounting only: no tip is ever
 * constructed, paid, or sent in Phase 2).
 */
import { lamportsFeeToQuote } from "./fee.js";
import type { PoolSnapshot } from "./types.js";

/**
 * Fallback CU price when getRecentPrioritizationFees yields no positive
 * samples. Zeros are filtered before taking the median: many slots carry
 * zero-fee transactions, and including them would underestimate the price
 * of timely inclusion — we prefer to overestimate costs.
 */
export const DEFAULT_CU_PRICE_MICRO_LAMPORTS = 1_000n;

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const BPS = 10_000n;

export interface CostInputs {
  /** quoteOut − quoteIn (curve math; fees/impact/slippage included). */
  grossProfitQuote: bigint;
  /** ADR-0007 base fee in quote units, headroom included. */
  baseFeeQuote: bigint;
  /** Live median CU price (micro-lamports per CU). */
  cuPriceMicroLamports: bigint;
  /** Modeled Jito tip fraction in basis points (owner band 5000–6000). */
  jitoTipFractionBps: number;
  /** Snapshot used to convert lamports → quote (same math as ADR-0007). */
  priceRef: PoolSnapshot;
}

export interface CostBreakdown {
  grossProfit: bigint;
  baseFee: bigint;
  /** null when simulation failed (no measured CU) — never fabricated. */
  priorityFee: bigint | null;
  jitoTip: bigint;
  jitoTipFraction: number;
  /** null when priorityFee is null. */
  netProfit: bigint | null;
  netComputable: boolean;
}

export function computeCosts(
  inp: CostInputs,
  cuLimit: number | null,
): CostBreakdown {
  const jitoTip =
    inp.grossProfitQuote > 0n
      ? (inp.grossProfitQuote * BigInt(inp.jitoTipFractionBps)) / BPS
      : 0n;
  const jitoTipFraction = inp.jitoTipFractionBps / 10_000;

  if (cuLimit === null) {
    return {
      grossProfit: inp.grossProfitQuote,
      baseFee: inp.baseFeeQuote,
      priorityFee: null,
      jitoTip,
      jitoTipFraction,
      netProfit: null,
      netComputable: false,
    };
  }

  // Priority fee lamports = ceil(cuLimit × cuPrice / 1e6): round UP so the
  // cost estimate never flatters an opportunity.
  const micro = BigInt(cuLimit) * inp.cuPriceMicroLamports;
  const priorityLamports =
    (micro + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  const priorityFee = lamportsFeeToQuote(priorityLamports, inp.priceRef);

  return {
    grossProfit: inp.grossProfitQuote,
    baseFee: inp.baseFeeQuote,
    priorityFee,
    jitoTip,
    jitoTipFraction,
    netProfit: inp.grossProfitQuote - inp.baseFeeQuote - priorityFee - jitoTip,
    netComputable: true,
  };
}

/** Median of positive prioritization-fee samples; fallback when none. */
export function medianCuPriceMicroLamports(
  fees: ReadonlyArray<{ prioritizationFee: number }>,
): bigint {
  const positive = fees
    .map((f) => f.prioritizationFee)
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);
  if (positive.length === 0) return DEFAULT_CU_PRICE_MICRO_LAMPORTS;
  return BigInt(positive[Math.floor(positive.length / 2)]!);
}
```

`src/types.ts` — add to `AttemptRecord` after `signature?: string;`:

```ts
  /** ADR-0009 cost breakdown (bigints serialize as decimal strings). */
  costs?: {
    grossProfit: bigint;
    baseFee: bigint;
    priorityFee: bigint | null;
    jitoTip: bigint;
    jitoTipFraction: number;
    netProfit: bigint | null;
    netComputable: boolean;
  };
```

`src/config.ts` — add `jitoTipFractionBps: number;` to `Config` (comment: ADR-0009 modeled tip, accounting only). In `loadConfig` before the return:

```ts
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
```

and in the returned object: `jitoTipFractionBps: Math.round(jitoTipFraction * 10_000),`.

`src/executor.ts` — extend `ExecuteMeta`:

```ts
  /**
   * ADR-0009: caller-supplied cost model. Called with the would-send CU
   * limit (or null when simulation failed); result is attached to the
   * attempt record. Optional so Phase-1 style callers/tests are unchanged.
   */
  computeCosts?: (cuLimit: number | null) => AttemptRecord["costs"];
```

In the sim-failed branch add `...(meta.computeCosts ? { costs: meta.computeCosts(null) } : {}),` to the record; in the shadow branch add `...(meta.computeCosts ? { costs: meta.computeCosts(cuLimit) } : {}),`.

`src/main.ts` — import `computeCosts`, `medianCuPriceMicroLamports`, `DEFAULT_CU_PRICE_MICRO_LAMPORTS` from `./costs.js`. Inside `main()` after `limiter` is created:

```ts
  // ADR-0009: live CU price, cached 30s so it doesn't eat the RPS budget.
  const CU_PRICE_TTL_MS = 30_000;
  let cuPriceCache = { value: DEFAULT_CU_PRICE_MICRO_LAMPORTS, fetchedAtMs: 0 };
  const currentCuPrice = async (): Promise<bigint> => {
    if (Date.now() - cuPriceCache.fetchedAtMs < CU_PRICE_TTL_MS) {
      return cuPriceCache.value;
    }
    try {
      await limiter.acquire();
      const fees = await connection.getRecentPrioritizationFees();
      cuPriceCache = {
        value: medianCuPriceMicroLamports(fees),
        fetchedAtMs: Date.now(),
      };
    } catch {
      cuPriceCache = { ...cuPriceCache, fetchedAtMs: Date.now() }; // keep last
    }
    return cuPriceCache.value;
  };
```

In the opportunity path, before `await execute(...)`:

```ts
    const cuPriceNow = await currentCuPrice();
```

and extend the execute meta:

```ts
      {
        cluster: cfg.cluster,
        dataSource: source.name,
        slot: pair.cpmm.slot,
        sendEnabled: cfg.sendEnabled,
        computeCosts: (cuLimit) =>
          computeCosts(
            {
              grossProfitQuote: decision.quoteOut - decision.quoteIn,
              baseFeeQuote: estTxFeeQuote,
              cuPriceMicroLamports: cuPriceNow,
              jitoTipFractionBps: cfg.jitoTipFractionBps,
              priceRef: pair.cpmm,
            },
            cuLimit,
          ),
      },
```

`.env.example` — after the EST_TX_FEE_QUOTE block:

```
# ADR-0009: modeled Jito tip fraction of gross profit for NET-profit
# accounting in shadow mode. A MODEL ONLY — no tip is ever paid or sent.
# Owner-approved band: 0.50–0.60. Default 0.55.
# JITO_TIP_FRACTION=0.55
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/costs.ts src/types.ts src/config.ts src/executor.ts src/main.ts .env.example tests/costs.test.ts tests/executor.test.ts tests/config.test.ts
git commit -m "T29: realistic cost model — priority fee + modeled Jito tip, gross AND net on every shadow record (ADR-0009)"
```

---

### Task 4: Mainnet probe script, Phase-2 env profile, first polling shadow run

**Files:**
- Create: `scripts/probe-mainnet-pools.ts`
- Create: `data/pools.mainnet.json` (script output, committed)
- Modify: `.env.example` (Phase-2 profile block)

**Interfaces:**
- Consumes: `decodeRaydiumCpmmPool` (`src/decode/raydiumCpmm.js`), `decodeWhirlpool` (`src/decode/orcaWhirlpool.js`), Raydium SDK `Raydium.load` + `api.fetchPoolByMints` (mainnet-only API — allowed, this is `scripts/`, off the hot path), Orca list API `https://api.mainnet.orca.so/v1/whirlpool/list`.
- Produces: `data/pools.mainnet.json` with `{ raydiumCpmmPool, orcaWhirlpool, baseMint, quoteMint, baseDecimals, quoteDecimals, observed: {...}, probedAt }` — consumed by the run configs of Tasks 4–5 and by Task 5's surrogate finder.

No unit tests: this is a read-only discovery script; its verification is its own printed on-chain evidence. Decoders it relies on are already unit-tested.

- [ ] **Step 1: Write `scripts/probe-mainnet-pools.ts`**

```ts
/**
 * READ-ONLY mainnet probe. Discovers a Raydium CPMM SOL/USDC pool and the
 * deepest Orca Whirlpool SOL/USDC pool, verifies both by decoding the
 * actual on-chain accounts with OUR decoders, and writes
 * data/pools.mainnet.json. Sends nothing; needs no keypair.
 *
 * Addresses are discovered live (project rule: never trust remembered
 * addresses). The SOL and USDC mints are cross-checked against what the
 * pools themselves store on-chain.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { writeFileSync } from "node:fs";
import { decodeRaydiumCpmmPool } from "../src/decode/raydiumCpmm.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
// Owner gate (plan Global Constraints): below this quote depth, STOP AND ASK.
const MIN_CPMM_QUOTE_RESERVE = 100_000_000_000n; // 100k USDC (6dp)

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  // --- USDC mint via Raydium API token list (verified on-chain below) ---
  const raydium = await Raydium.load({ connection, disableLoadToken: false });
  const usdc = raydium.token.tokenList.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("USDC not found in Raydium token list");
  console.log(`[probe] USDC mint per Raydium list: ${usdc.address}`);

  // --- Raydium CPMM SOL/USDC pool: pick deepest CPMM-program pool ---
  const pools = await raydium.api.fetchPoolByMints({
    mint1: SOL_MINT,
    mint2: usdc.address,
  });
  const cpmmPools = (pools.data ?? []).filter(
    (p: { programId: string }) => p.programId === CPMM_PROGRAM,
  );
  if (cpmmPools.length === 0) {
    throw new Error("no SOL/USDC pool on the CPMM program found via API");
  }
  cpmmPools.sort((a: { tvl: number }, b: { tvl: number }) => b.tvl - a.tvl);
  const rayApi = cpmmPools[0];
  console.log(`[probe] Raydium CPMM candidate ${rayApi.id} (tvl $${rayApi.tvl})`);

  // --- Orca whirlpool SOL/USDC: deepest from Orca's public list ---
  const orcaResp = await fetch("https://api.mainnet.orca.so/v1/whirlpool/list");
  if (!orcaResp.ok) throw new Error(`orca list HTTP ${orcaResp.status}`);
  const orcaList = (await orcaResp.json()) as {
    whirlpools: Array<{
      address: string;
      tokenA: { mint: string };
      tokenB: { mint: string };
      tvl?: number;
    }>;
  };
  const orcaCandidates = orcaList.whirlpools
    .filter(
      (w) => w.tokenA.mint === SOL_MINT && w.tokenB.mint === usdc.address,
    )
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  if (orcaCandidates.length === 0) throw new Error("no SOL/USDC whirlpool found");
  const orcaApi = orcaCandidates[0]!;
  console.log(`[probe] Orca whirlpool candidate ${orcaApi.address} (tvl $${orcaApi.tvl})`);

  // --- VERIFY both on-chain with our own decoders ---
  const [rayAcc, orcaAcc] = await connection.getMultipleAccountsInfo([
    new PublicKey(rayApi.id),
    new PublicKey(orcaApi.address),
  ]);
  if (!rayAcc || !orcaAcc) throw new Error("candidate account(s) missing on-chain");
  const ray = decodeRaydiumCpmmPool(rayAcc.data);
  const orca = decodeWhirlpool(orcaAcc.data);

  const rayMints = [ray.token0Mint.toBase58(), ray.token1Mint.toBase58()];
  if (!rayMints.includes(SOL_MINT) || !rayMints.includes(usdc.address)) {
    throw new Error(`CPMM pool mints ${rayMints} != SOL/USDC — refusing`);
  }
  if (
    orca.tokenMintA.toBase58() !== SOL_MINT ||
    orca.tokenMintB.toBase58() !== usdc.address
  ) {
    throw new Error("whirlpool mints are not SOL(A)/USDC(B) — refusing");
  }

  // --- Depth check: read the CPMM USDC vault balance ---
  const usdcVault = ray.token0Mint.toBase58() === usdc.address
    ? ray.token0Vault
    : ray.token1Vault;
  const vaultBal = await connection.getTokenAccountBalance(usdcVault);
  const quoteReserve = BigInt(vaultBal.value.amount);
  console.log(`[probe] CPMM USDC reserve: ${vaultBal.value.uiAmountString}`);
  const depthOk = quoteReserve >= MIN_CPMM_QUOTE_RESERVE;
  if (!depthOk) {
    console.log(
      `[probe] *** DEPTH GATE FAILED: < 100k USDC — STOP AND ASK THE OWNER ` +
        `before any shadow run (owner Decision 6). ***`,
    );
  }

  const out = {
    probedAt: new Date().toISOString(),
    cluster: "mainnet-beta",
    baseMint: SOL_MINT,
    quoteMint: usdc.address,
    baseDecimals: 9,
    quoteDecimals: usdc.decimals,
    raydiumCpmmPool: rayApi.id,
    orcaWhirlpool: orcaApi.address,
    observed: {
      raydiumTvlUsd: rayApi.tvl,
      orcaTvlUsd: orcaApi.tvl ?? null,
      cpmmUsdcReserve: quoteReserve.toString(),
      whirlpoolLiquidity: orca.liquidity.toString(),
      whirlpoolTickCurrentIndex: orca.tickCurrentIndex,
      depthGatePassed: depthOk,
    },
  };
  writeFileSync("data/pools.mainnet.json", JSON.stringify(out, null, 2) + "\n");
  console.log("[probe] wrote data/pools.mainnet.json");
}

main().catch((e) => {
  console.error(`[probe] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

NOTE for implementer: field names on the Raydium API response (`programId`, `tvl`, `id`) and the Orca list shape should be verified against the live response the first time the script runs — adjust the two `filter`/`sort` call sites if the shapes differ; everything else (on-chain decode + mint verification) is independent of API shape. `usdc.decimals` — if absent on the token-list entry, hardcode check `=== 6` against the vault balance response's `decimals` field instead.

- [ ] **Step 2: Run it (read-only)**

Run: `npx tsx scripts/probe-mainnet-pools.ts`
Expected: prints both candidates + reserve, writes `data/pools.mainnet.json` with `depthGatePassed: true`.

**GATE: if `depthGatePassed` is false — STOP. Report the observed depth to the owner and do not continue this plan (owner Decision 6).**

- [ ] **Step 3: Add the Phase-2 profile block to `.env.example`**

Append:

```
# ---- Phase 2 (mainnet shadow mode) profile ----
# Run WITHOUT editing .env: pass these on the command line. Pool addresses
# and the USDC mint come from data/pools.mainnet.json (probe output) —
# never from memory. The send path is structurally disabled at PHASE=2
# (ADR-0008): loadConfig derives sendEnabled=false, the executor refuses,
# and the send transport throws.
# PHASE=2
# CLUSTER=mainnet-beta
# KEYPAIR_PATH=keypairs/mainnet-shadow.json   # fresh; NEVER funded, NEVER the devnet key
# DATA_SOURCE=polling
# RAYDIUM_POOL_ADDRESS=<from data/pools.mainnet.json>
# ORCA_POOL_ADDRESS=<from data/pools.mainnet.json>
# BASE_MINT=So11111111111111111111111111111111111111112
# QUOTE_MINT=<from data/pools.mainnet.json>
# BASE_DECIMALS=9
# QUOTE_DECIMALS=6
# TRADE_SIZE_QUOTE=100000000        # 100 USDC notional for realistic impact
# MIN_PROFIT_THRESHOLD_QUOTE=10000  # 0.01 USDC
# SLIPPAGE_TOLERANCE_BPS=50
# MAX_RPS=8
# POLL_INTERVAL_MS=1500
```

- [ ] **Step 4: First shadow run (15-minute verification run)**

Run (values substituted from `data/pools.mainnet.json`):

```bash
PHASE=2 CLUSTER=mainnet-beta KEYPAIR_PATH=keypairs/mainnet-shadow.json \
DATA_SOURCE=polling RAYDIUM_POOL_ADDRESS=<ray> ORCA_POOL_ADDRESS=<orca> \
BASE_MINT=So11111111111111111111111111111111111111112 QUOTE_MINT=<usdc> \
BASE_DECIMALS=9 QUOTE_DECIMALS=6 TRADE_SIZE_QUOTE=100000000 \
MIN_PROFIT_THRESHOLD_QUOTE=10000 SLIPPAGE_TOLERANCE_BPS=50 MAX_RPS=8 \
POLL_INTERVAL_MS=1500 npm start
```

Expected console: the SHADOW MODE banner, live fee fetch `(rpc)` line, per-cycle `[attempt]` lines (`no-opportunity` or `shadow-simulated`/`aborted-simulation-failed` — sims will fail on wallet errors until Task 5, which is expected and honest).

- [ ] **Step 5: Verify no send occurred, structurally and empirically**

```bash
grep -c '"cluster":"mainnet-beta"' logs/attempts.jsonl
grep '"cluster":"mainnet-beta"' logs/attempts.jsonl | grep -c '"action":"sent"' || true
```

Expected: first count > 0; second count **0**. Also confirm the mainnet wallet was never funded (it was never even created before this run) — no SOL was needed because nothing was sent.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-mainnet-pools.ts data/pools.mainnet.json .env.example
git commit -m "T30: mainnet SOL/USDC pool probe + Phase-2 shadow profile; first shadow run verified sendless"
```

---

### Task 5: Surrogate-owner simulation (signerless build + live-discovered owner)

**Files:**
- Modify: `src/txbuilder/index.ts` (payer `Keypair | PublicKey`, sign only for Keypair)
- Modify: `src/config.ts` (`surrogateOwner?: string` via `SURROGATE_OWNER`)
- Modify: `src/main.ts` (shadow builds use the surrogate PublicKey)
- Create: `scripts/find-surrogate.ts`
- Modify: `.env.example` (SURROGATE_OWNER line in the Phase-2 block)
- Test: `tests/txbuilder.test.ts` (append)

**Interfaces:**
- Consumes: `ArbBuildContext` (Task 0 state), `data/pools.mainnet.json` (Task 4).
- Produces: `ArbBuildContext.payer: Keypair | PublicKey`; a `PublicKey` payer yields an UNSIGNED `VersionedTransaction` (all-zero signatures — a fourth, incidental send barrier: an unsigned tx is unsubmittable). `Config.surrogateOwner?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/txbuilder.test.ts` (reuse that file's existing context fixture; shown here as `makeCtx()` — adapt to the fixture name actually present):

```ts
describe("signerless build for shadow-mode surrogate simulation", () => {
  it("accepts a PublicKey payer and leaves the tx UNSIGNED", () => {
    const surrogate = Keypair.generate().publicKey;
    const ctx = { ...makeCtx(), payer: surrogate };
    const tx = buildArbTransaction(ctx, opp);
    expect(tx.signatures.length).toBeGreaterThan(0);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    // token accounts are derived from the surrogate, not any local wallet
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(surrogate.toBase58());
  });

  it("still signs when payer is a Keypair (Phase-1 path unchanged)", () => {
    const tx = buildArbTransaction(makeCtx(), opp);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/txbuilder.test.ts`
Expected: FAIL — type error (payer must be Keypair).

- [ ] **Step 3: Implement**

`src/txbuilder/index.ts`:

```ts
export interface ArbBuildContext {
  /**
   * Keypair → tx is signed (Phase-1 live path). PublicKey → tx is built
   * UNSIGNED for shadow-mode simulation as a surrogate owner
   * (sigVerify:false); an unsigned tx is also unsubmittable — an extra
   * ADR-0008 barrier.
   */
  payer: Keypair | PublicKey;
  ...
}
```

At the top of `buildArbTransaction` replace `const owner = ctx.payer.publicKey;` with:

```ts
  const owner = ctx.payer instanceof Keypair ? ctx.payer.publicKey : ctx.payer;
```

Replace the two `const owner = ctx.payer.publicKey;` lines in `buildCpmmLeg` / `buildWhirlpoolLeg` the same way (or better: compute once and pass `owner: PublicKey` into both leg builders as a parameter — smaller surface, do that). At the end:

```ts
  const tx = new VersionedTransaction(message);
  if (ctx.payer instanceof Keypair) tx.sign([ctx.payer]);
  return tx;
```

`src/config.ts` — add `surrogateOwner?: string;` to `Config` (comment: shadow-mode simulation owner, discovered live by scripts/find-surrogate.ts) and in the returned object:

```ts
    ...(env.SURROGATE_OWNER ? { surrogateOwner: env.SURROGATE_OWNER } : {}),
```

`src/main.ts` — in `setUp`'s polling branch, derive the build payer once:

```ts
    // Shadow mode simulates as a live-discovered funded surrogate so
    // simulation results reflect the strategy, not our unfunded wallet.
    const buildPayer: Keypair | PublicKey =
      !cfg.sendEnabled && cfg.surrogateOwner
        ? new PublicKey(cfg.surrogateOwner)
        : wallet;
    if (!cfg.sendEnabled && !cfg.surrogateOwner) {
      console.log(
        "[main] WARNING: shadow mode without SURROGATE_OWNER — simulations " +
          "will fail on wallet errors (unfunded local wallet)",
      );
    }
```

and use `payer: buildPayer` in that branch's `buildMeta`. (Leave the synthetic branch on `wallet` — it is devnet/Phase-1 tooling.)

`scripts/find-surrogate.ts`:

```ts
/**
 * READ-ONLY. Finds a mainnet surrogate owner for shadow-mode simulation:
 * a wallet whose USDC and WSOL ASSOCIATED token accounts both exist with
 * balances (the tx builder derives ATAs from the owner, so the surrogate's
 * holdings must live in ATAs). Prints candidates; the chosen one goes into
 * SURROGATE_OWNER for shadow runs.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { associatedTokenAddress } from "../src/txbuilder/index.js";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const pools = JSON.parse(readFileSync("data/pools.mainnet.json", "utf8"));
  const usdcMint = new PublicKey(pools.quoteMint);
  const wsolMint = new PublicKey(pools.baseMint);

  const largest = await connection.getTokenLargestAccounts(usdcMint);
  for (const acc of largest.value) {
    const info = await connection.getParsedAccountInfo(acc.address);
    const data = info.value?.data;
    if (!data || !("parsed" in data)) continue;
    const owner = new PublicKey(data.parsed.info.owner as string);
    // Must be the ATA (program-owned vaults/PDAs fail this check).
    if (!associatedTokenAddress(owner, usdcMint).equals(acc.address)) continue;
    const wsolAta = associatedTokenAddress(owner, wsolMint);
    const wsol = await connection.getTokenAccountBalance(wsolAta).catch(() => null);
    if (!wsol || BigInt(wsol.value.amount) === 0n) continue;
    console.log(
      `[surrogate] CANDIDATE ${owner.toBase58()} — USDC ${acc.uiAmountString}, ` +
        `WSOL ${wsol.value.uiAmountString}`,
    );
    return;
  }
  console.log("[surrogate] none of the top USDC ATAs also hold WSOL — widen search");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[surrogate] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

`.env.example` — add to the Phase-2 block:

```
# SURROGATE_OWNER=<from scripts/find-surrogate.ts — funded wallet whose ATAs
#   shadow simulation borrows via sigVerify:false; read-only, nothing is sent>
```

- [ ] **Step 4: Run suite, then discover the surrogate and re-run shadow**

Run: `npm test && npm run typecheck` → PASS.
Run: `npx tsx scripts/find-surrogate.ts` → prints a candidate owner.
Re-run the Task 4 Step 4 command with `SURROGATE_OWNER=<candidate>` added, for ~10 minutes.
Expected: `shadow-simulated` records now appear with `simulation.err: null` (or real program-level errors — either is honest data) and `costs.netComputable: true`.

- [ ] **Step 5: Verify zero sends again**

```bash
grep '"cluster":"mainnet-beta"' logs/attempts.jsonl | grep -c '"action":"sent"' || true
```
Expected: **0**.

- [ ] **Step 6: Commit**

```bash
git add src/txbuilder/index.ts src/config.ts src/main.ts scripts/find-surrogate.ts .env.example tests/txbuilder.test.ts
git commit -m "T31: surrogate-owner shadow simulation — signerless build, live-discovered owner"
```

---

### Task 6: Stats module + `scripts/shadow-stats.ts`

**Files:**
- Create: `src/stats.ts`
- Create: `scripts/shadow-stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `logs/attempts.jsonl` lines as serialized by `src/logger.ts` (bigints as decimal strings; `costs` block from Task 3; `detail.latency` from Task 7 may be absent — handle missing).
- Produces: `computeShadowStats(lines: string[], opts?: StatsOptions): ShadowStats` (pure) and the CLI.

- [ ] **Step 1: Write the failing tests (`tests/stats.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { computeShadowStats } from "../src/stats.js";

const t0 = Date.parse("2026-07-17T00:00:00Z");
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60_000).toISOString();

function line(over: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: iso(0),
    cluster: "mainnet-beta",
    dataSource: "polling",
    slot: 1,
    gapBps: 0,
    decision: "no-opportunity",
    reason: "r",
    ...over,
  });
}
const shadow = (net: string | null, gross: string, offsetMin: number, err: unknown = null) =>
  line({
    timestamp: iso(offsetMin),
    decision: "opportunity",
    action: err === null ? "shadow-simulated" : "aborted-simulation-failed",
    simulation: { err },
    costs: {
      grossProfit: gross, baseFee: "900", priorityFee: net === null ? null : "150",
      jitoTip: "550000", jitoTipFraction: 0.55, netProfit: net,
      netComputable: net !== null,
    },
  });

describe("computeShadowStats", () => {
  const lines = [
    line({}), // no-opportunity cycle
    shadow("111450", "1000000", 10),
    shadow("-2000", "300000", 20),
    shadow(null, "500000", 30, { InstructionError: [0, "Custom"] }),
    line({ timestamp: iso(40), cluster: "devnet" }), // filtered out
  ];

  it("counts opportunities and rates over the observed window", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.opportunities).toBe(3);
    expect(s.simFailures).toBe(1);
    expect(s.revertRate).toBeCloseTo(1 / 3);
    // window = first..last mainnet timestamp = 30 min → 0.5h
    expect(s.opportunitiesPerHour).toBeCloseTo(6);
  });

  it("separates gross-positive from NET-positive (the go/no-go signal)", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.grossPositive).toBe(3);
    expect(s.netPositive).toBe(1);
    expect(s.netPositiveRate).toBeCloseTo(1 / 3);
  });

  it("averages/medians use only computable values; bigint-safe", () => {
    const s = computeShadowStats(lines, { cluster: "mainnet-beta" });
    expect(s.medianGross).toBe(500000n);
    expect(s.avgNet).toBe((111450n + -2000n) / 2n);
    expect(s.medianNet).toBe(-2000n);
  });

  it("handles an empty window without dividing by zero", () => {
    const s = computeShadowStats([], {});
    expect(s.opportunities).toBe(0);
    expect(s.opportunitiesPerHour).toBe(0);
    expect(s.avgNet).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/stats.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/stats.ts`**

```ts
/**
 * Pure shadow-mode statistics over logs/attempts.jsonl lines (Phase 2 exit
 * data): opportunities/hour, gross vs NET positive rates (the Phase-3
 * go/no-go signal), revert rate, latency percentiles. Bigint-safe: profit
 * fields arrive as decimal strings from the logger's serializer.
 */

export interface StatsOptions {
  cluster?: string;
  sinceMs?: number;
  untilMs?: number;
}

export interface ShadowStats {
  windowStart: string | null;
  windowEnd: string | null;
  hours: number;
  totalRecords: number;
  opportunities: number;
  opportunitiesPerHour: number;
  grossPositive: number;
  netPositive: number;
  grossPositiveRate: number;
  netPositiveRate: number;
  avgGross: bigint | null;
  medianGross: bigint | null;
  avgNet: bigint | null;
  medianNet: bigint | null;
  simFailures: number;
  revertRate: number;
  latency: {
    dataAgeMsP50: number | null;
    dataAgeMsP95: number | null;
    detectComputeMsP50: number | null;
    detectComputeMsP95: number | null;
  };
}

interface ParsedRecord {
  timestamp: string;
  cluster: string;
  decision: string;
  action?: string;
  costs?: {
    grossProfit: string;
    netProfit: string | null;
    netComputable: boolean;
  };
  detail?: { latency?: { dataAgeMs: number; detectComputeMs: number } };
}

export function computeShadowStats(
  lines: string[],
  opts: StatsOptions = {},
): ShadowStats {
  const recs: ParsedRecord[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let rec: ParsedRecord;
    try {
      rec = JSON.parse(raw) as ParsedRecord;
    } catch {
      continue; // torn tail line from a live-appending process
    }
    const ts = Date.parse(rec.timestamp);
    if (opts.cluster && rec.cluster !== opts.cluster) continue;
    if (opts.sinceMs !== undefined && ts < opts.sinceMs) continue;
    if (opts.untilMs !== undefined && ts > opts.untilMs) continue;
    recs.push(rec);
  }

  const opportunities = recs.filter((r) => r.decision === "opportunity");
  const simFailures = opportunities.filter(
    (r) => r.action === "aborted-simulation-failed",
  ).length;

  const gross = opportunities
    .map((r) => r.costs?.grossProfit)
    .filter((g): g is string => g !== undefined)
    .map(BigInt);
  const net = opportunities
    .map((r) => (r.costs?.netComputable ? r.costs.netProfit : null))
    .filter((n): n is string => n !== null && n !== undefined)
    .map(BigInt);

  const first = recs[0] ? Date.parse(recs[0].timestamp) : null;
  const last = recs.length ? Date.parse(recs[recs.length - 1]!.timestamp) : null;
  const hours = first !== null && last !== null && last > first
    ? (last - first) / 3_600_000
    : 0;

  const dataAges = latencies(recs, "dataAgeMs");
  const detectMs = latencies(recs, "detectComputeMs");

  return {
    windowStart: recs[0]?.timestamp ?? null,
    windowEnd: recs.length ? recs[recs.length - 1]!.timestamp : null,
    hours,
    totalRecords: recs.length,
    opportunities: opportunities.length,
    opportunitiesPerHour: hours > 0 ? opportunities.length / hours : 0,
    grossPositive: gross.filter((g) => g > 0n).length,
    netPositive: net.filter((n) => n > 0n).length,
    grossPositiveRate: rate(gross.filter((g) => g > 0n).length, opportunities.length),
    netPositiveRate: rate(net.filter((n) => n > 0n).length, opportunities.length),
    avgGross: avg(gross),
    medianGross: median(gross),
    avgNet: avg(net),
    medianNet: median(net),
    simFailures,
    revertRate: rate(simFailures, opportunities.length),
    latency: {
      dataAgeMsP50: percentile(dataAges, 50),
      dataAgeMsP95: percentile(dataAges, 95),
      detectComputeMsP50: percentile(detectMs, 50),
      detectComputeMsP95: percentile(detectMs, 95),
    },
  };
}

function latencies(
  recs: ParsedRecord[],
  key: "dataAgeMs" | "detectComputeMs",
): number[] {
  return recs
    .map((r) => r.detail?.latency?.[key])
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function avg(xs: bigint[]): bigint | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length) : null;
}

function median(xs: bigint[]): bigint | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
```

Create `scripts/shadow-stats.ts`:

```ts
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
  JSON.stringify(
    s,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
```

- [ ] **Step 4: Run suite + smoke the CLI on the real log**

Run: `npm test && npm run typecheck` → PASS.
Run: `npx tsx scripts/shadow-stats.ts --cluster mainnet-beta` → prints stats JSON over the Task 4/5 runs.

- [ ] **Step 5: Commit**

```bash
git add src/stats.ts scripts/shadow-stats.ts tests/stats.test.ts
git commit -m "T32: shadow-mode stats — gross vs net-positive rates, revert rate, latency percentiles"
```

---

### Task 7: GeyserPriceSource (code only — never run) + latency instrumentation

**Files:**
- Create: `src/datasource/geyser.ts`
- Modify: `src/config.ts` (`dataSource: "geyser"`, `geyserEndpoint?`, `geyserXToken?`), `src/main.ts` (geyser branch + latency detail), `src/executor.ts` (`ExecuteMeta.latency?`), `.env.example`
- Modify: `package.json` (exact-pin `@triton-one/yellowstone-grpc` as a dependency)
- Test: `tests/geyser.test.ts`, `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: `PriceSource`/`SnapshotPair` (ADR-0006), `decodeRaydiumCpmmPool`, `decodeWhirlpool`.
- Produces: `GeyserPriceSource implements PriceSource` (`name = "geyser"`) driven by an injected `GeyserTransport`; `ExecuteMeta.latency?: { dataAgeMs: number; detectComputeMs: number }` merged into record `detail` (also on no-opportunity records). NOT RUNNABLE without `GEYSER_ENDPOINT` — owner Decision 3: build, don't procure.

- [ ] **Step 1: Pin the dependency**

Run: `npm view @triton-one/yellowstone-grpc version` then `npm install --save-exact @triton-one/yellowstone-grpc@<that version>`.
Verify: `git diff package.json` shows ONLY the new exact-pinned entry; existing pins untouched. Run `npm test` — still green.

- [ ] **Step 2: Write the failing tests (`tests/geyser.test.ts`)**

The transport is injected so tests never open a network connection:

```ts
import { describe, expect, it } from "vitest";
import {
  GeyserPriceSource,
  type GeyserAccountUpdate,
  type GeyserTransport,
} from "../src/datasource/geyser.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";
import type { PoolSnapshot } from "../src/types.js";

const pair = { baseMint: "SOL", quoteMint: "USDC", baseDecimals: 9, quoteDecimals: 6 };

/** Decoders are injected too, so tests need no real account bytes. */
const decoders = {
  decodeCpmm: (_: Uint8Array): PoolSnapshot["kind"] extends never ? never : {
    baseReserve: bigint; quoteReserve: bigint; feeBps: number;
  } => ({ baseReserve: 10n, quoteReserve: 1500n, feeBps: 25 }),
  decodeWhirl: (_: Uint8Array) => ({
    sqrtPriceX64: 7n, liquidity: 5n, tickCurrentIndex: -1, feeBps: 30,
  }),
};

class FakeTransport implements GeyserTransport {
  handler: ((u: GeyserAccountUpdate) => void) | null = null;
  closed = false;
  private resolveDone!: () => void;
  done = new Promise<void>((r) => (this.resolveDone = r));
  async subscribe(_accounts: string[], onUpdate: (u: GeyserAccountUpdate) => void) {
    this.handler = onUpdate;
    return this.done;
  }
  close() { this.closed = true; this.resolveDone(); }
  push(u: GeyserAccountUpdate) { this.handler!(u); }
}

const upd = (pubkey: string, slot: number): GeyserAccountUpdate => ({
  pubkey, data: new Uint8Array([1]), slot, receivedAtMs: 1000 + slot,
});

function makeSource(t: FakeTransport) {
  return new GeyserPriceSource(t, {
    raydiumPoolAddress: "RAY", orcaPoolAddress: "ORCA", pair,
    decodeCpmm: decoders.decodeCpmm, decodeWhirl: decoders.decodeWhirl,
  });
}

describe("GeyserPriceSource", () => {
  it("emits a pair only once BOTH pools have been seen, then on every update", async () => {
    const t = new FakeTransport();
    const source = makeSource(t);
    const pairs: SnapshotPair[] = [];
    const run = source.run(async (p) => { pairs.push(p); });

    t.push(upd("RAY", 100));
    expect(pairs.length).toBe(0); // whirlpool not seen yet
    t.push(upd("ORCA", 101));
    expect(pairs.length).toBe(1);
    t.push(upd("RAY", 102));
    expect(pairs.length).toBe(2);
    expect(pairs[1]!.cpmm.slot).toBe(102);
    expect(pairs[1]!.whirlpool.slot).toBe(101); // freshest known state
    expect(pairs[0]!.cpmm.source).toBe("geyser");
    expect(pairs[0]!.cpmm.fetchedAtMs).toBe(1100); // transport receive time

    source.stop();
    await run;
    expect(t.closed).toBe(true);
  });

  it("ignores updates for unknown accounts", async () => {
    const t = new FakeTransport();
    const source = makeSource(t);
    const pairs: SnapshotPair[] = [];
    const run = source.run(async (p) => { pairs.push(p); });
    t.push(upd("RAY", 1));
    t.push(upd("SOMETHING_ELSE", 2));
    expect(pairs.length).toBe(0);
    source.stop();
    await run;
  });
});
```

Config test — append to `tests/config.test.ts`:

```ts
  it("DATA_SOURCE=geyser requires GEYSER_ENDPOINT plus the polling pool keys", () => {
    expect(() =>
      loadConfig(shadowEnv({ DATA_SOURCE: "geyser" })),
    ).toThrow(/GEYSER_ENDPOINT/);
  });
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `npm test -- tests/geyser.test.ts tests/config.test.ts` → FAIL (module missing).

Create `src/datasource/geyser.ts`:

```ts
/**
 * Yellowstone Geyser gRPC price source (ADR-0006 drop-in; Phase 2
 * deliverable per the updated phase doc — built now, RUN ONLY once the
 * owner provides an endpoint; Geyser is not on the Helius free tier and
 * procurement is a stop-and-ask money item).
 *
 * The gRPC client is isolated behind GeyserTransport so this class is
 * pure and unit-testable; YellowstoneTransport below is the only part
 * that touches the wire, and it is exercised only when GEYSER_ENDPOINT
 * is configured.
 */
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";

export interface GeyserAccountUpdate {
  pubkey: string;
  data: Uint8Array;
  slot: number;
  /** Wall-clock ms when the update reached us (drives dataAgeMs). */
  receivedAtMs: number;
}

export interface GeyserTransport {
  /** Resolves when the stream ends (after close()). */
  subscribe(
    accounts: string[],
    onUpdate: (u: GeyserAccountUpdate) => void,
  ): Promise<void>;
  close(): void;
}

export interface GeyserSourceOptions {
  raydiumPoolAddress: string;
  orcaPoolAddress: string;
  pair: PairInfo;
  decodeCpmm: (data: Uint8Array) => {
    baseReserve: bigint;
    quoteReserve: bigint;
    feeBps: number;
  };
  decodeWhirl: (data: Uint8Array) => {
    sqrtPriceX64: bigint;
    liquidity: bigint;
    tickCurrentIndex: number;
    feeBps: number;
  };
}

export class GeyserPriceSource implements PriceSource {
  readonly name = "geyser";
  private latestCpmm: PoolSnapshot | null = null;
  private latestWhirl: PoolSnapshot | null = null;

  constructor(
    private readonly transport: GeyserTransport,
    private readonly opts: GeyserSourceOptions,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    await this.transport.subscribe(
      [this.opts.raydiumPoolAddress, this.opts.orcaPoolAddress],
      (u) => {
        this.apply(u);
        if (this.latestCpmm && this.latestWhirl) {
          void onPair({
            cpmm: this.latestCpmm,
            whirlpool: this.latestWhirl,
          } satisfies SnapshotPair);
        }
      },
    );
  }

  stop(): void {
    this.transport.close();
  }

  private apply(u: GeyserAccountUpdate): void {
    const base = {
      pair: this.opts.pair,
      fetchedAtMs: u.receivedAtMs,
      slot: u.slot,
      source: this.name,
    };
    if (u.pubkey === this.opts.raydiumPoolAddress) {
      this.latestCpmm = {
        kind: "cpmm",
        dex: "raydium-cpmm",
        poolAddress: u.pubkey,
        ...base,
        ...this.opts.decodeCpmm(u.data),
      };
    } else if (u.pubkey === this.opts.orcaPoolAddress) {
      this.latestWhirl = {
        kind: "whirlpool",
        dex: "orca-whirlpool",
        poolAddress: u.pubkey,
        ...base,
        ...this.opts.decodeWhirl(u.data),
      };
    }
  }
}
```

Add, in the same file, the concrete transport (verify the client API against the SDK docs via context7 at implementation time — the subscribe-request shape below follows the SDK README):

```ts
/** Real Yellowstone wiring. Constructed only when GEYSER_ENDPOINT is set. */
export async function createYellowstoneTransport(
  endpoint: string,
  xToken: string | undefined,
): Promise<GeyserTransport> {
  const { default: Client, CommitmentLevel } = await import(
    "@triton-one/yellowstone-grpc"
  );
  const client = new Client(endpoint, xToken, undefined);
  let stream: Awaited<ReturnType<typeof client.subscribe>> | null = null;
  return {
    async subscribe(accounts, onUpdate) {
      stream = await client.subscribe();
      const request = {
        accounts: {
          pools: { account: accounts, owner: [], filters: [] },
        },
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.PROCESSED,
      };
      await new Promise<void>((resolve, reject) =>
        stream!.write(request, (err: unknown) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve, reject) => {
        stream!.on("data", (msg: {
          account?: {
            account?: { pubkey: Uint8Array; data: Uint8Array };
            slot?: string;
          };
        }) => {
          const acc = msg.account?.account;
          if (!acc) return;
          onUpdate({
            pubkey: bs58encode(acc.pubkey),
            data: acc.data,
            slot: Number(msg.account?.slot ?? 0),
            receivedAtMs: Date.now(),
          });
        });
        stream!.on("error", reject);
        stream!.on("end", resolve);
        stream!.on("close", resolve);
      });
    },
    close() {
      stream?.end();
    },
  };
}

// Local, dependency-free base58 (pubkeys arrive as raw bytes on the stream).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
```

`src/config.ts` — widen `dataSource` to `"polling" | "synthetic" | "geyser"`, add `geyserEndpoint?: string;` / `geyserXToken?: string;`, accept `"geyser"` in the DATA_SOURCE validation, require the same six pool/pair keys as polling for geyser (extend the existing `dataSource === "polling"` check to `dataSource === "polling" || dataSource === "geyser"`), and additionally:

```ts
  if (dataSource === "geyser" && !env.GEYSER_ENDPOINT) {
    throw new ConfigError(
      "DATA_SOURCE=geyser requires GEYSER_ENDPOINT (owner Decision 3: " +
        "endpoint procurement is deferred — this source is code-complete " +
        "but not runnable until an endpoint exists)",
    );
  }
```

with `...(env.GEYSER_ENDPOINT ? { geyserEndpoint: env.GEYSER_ENDPOINT } : {})` and same for `GEYSER_X_TOKEN` in the returned object.

`src/main.ts` — geyser branch in `setUp` (mirrors the polling branch's static-metadata fetch and buildMeta; only the source differs):

```ts
  if (cfg.dataSource === "geyser") {
    const transport = await createYellowstoneTransport(
      cfg.geyserEndpoint!,
      cfg.geyserXToken,
    );
    const source = new GeyserPriceSource(transport, {
      raydiumPoolAddress: cfg.raydiumPoolAddress!,
      orcaPoolAddress: cfg.orcaPoolAddress!,
      pair,
      decodeCpmm: (data) => {
        const s = decodeRaydiumCpmmPool(Buffer.from(data));
        // Reserves live in vault token accounts, not the pool account; a
        // full Geyser build also subscribes both vaults. Phase-2 code-only
        // scope: subscribe pool accounts, reuse decoded fee/state, and
        // leave vault subscription as the documented gap to close when an
        // endpoint exists (logged in the session doc; do NOT run live).
        throw new Error("geyser vault subscription not wired — see session log");
      },
      decodeWhirl: (data) => {
        const s = decodeWhirlpool(Buffer.from(data));
        return {
          sqrtPriceX64: s.sqrtPriceX64,
          liquidity: s.liquidity,
          tickCurrentIndex: s.tickCurrentIndex,
          feeBps: s.feeBps,
        };
      },
    });
    ...same static-metadata fetch + buildMeta as the polling branch...
    return { source, buildMeta, feeLamportsWithHeadroom };
  }
```

IMPLEMENTER NOTE: if extracting the shared static-metadata/buildMeta code from the polling branch into a helper keeps `setUp` readable, do it; do not duplicate 40 lines.

Latency instrumentation (both sources) in `main.ts`'s run handler:

```ts
    const cycleStart = performance.now();
    const decision = detect(...);
    const detectComputeMs = performance.now() - cycleStart;
    const dataAgeMs =
      Date.now() - Math.max(pair.cpmm.fetchedAtMs, pair.whirlpool.fetchedAtMs);
    const latency = { dataAgeMs, detectComputeMs };
```

Add `detail: { latency }` to the no-opportunity record, add `latency?: { dataAgeMs: number; detectComputeMs: number };` to `ExecuteMeta`, spread it into `base.detail` in `execute` (`...(meta.latency ? { latency: meta.latency } : {})`), and pass `latency` in the execute meta.

`.env.example` — add to the Phase-2 block:

```
# DATA_SOURCE=geyser needs an endpoint (NOT on the Helius free tier —
# owner decision pending; do not procure):
# GEYSER_ENDPOINT=
# GEYSER_X_TOKEN=
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Do NOT run DATA_SOURCE=geyser live (no endpoint; owner Decision 3).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/datasource/geyser.ts src/config.ts src/main.ts src/executor.ts .env.example tests/geyser.test.ts tests/config.test.ts
git commit -m "T33: GeyserPriceSource behind PriceSource (code only, endpoint pending) + detection-latency instrumentation"
```

---

### Task 8: ADR-0008, ADR-0009, phase/handoff/session docs, kick off the 72h run

**Files:**
- Create: `docs/adr/0008-structural-send-disable-shadow-mode.md`, `docs/adr/0009-realistic-cost-model.md`
- Modify: `docs/adr/README.md`, `docs/phases/phase-2-mainnet-shadow-mode.md` (Status → IN PROGRESS; check off build tasks 1–4; note exit-criteria duration = 72h per owner), `docs/HANDOFF.md` (new "Last updated" section on top, per its convention)
- Create: `docs/sessions/2026-07-17.md` (four-part summary)

**Interfaces:** none — documentation. Content requirements:

- ADR-0008 "Structural send-disable for shadow mode": context (Phase 2 + owner instruction), decision (the three layers + the incidental fourth: shadow txs are unsigned), alternatives (single-layer flag; null transport only — and why layered won), consequences (Phase 3 requires code change + ADR; SEND_ENABLED forever rejected). Status: `accepted` (owner approved the design 2026-07-17).
- ADR-0009 "Realistic cost model": gross-vs-net definitions, curve-math-includes-pool-fees/impact argument, priority fee = would-send CU limit × live median CU price (zeros filtered, ceil — conservative both ways), modeled Jito tip = 0.55 × positive gross (band 0.50–0.60, env-clamped), tip is accounting only (no Jito integration in Phase 2), netComputable=false rather than fabricated numbers when simulation fails. Status: `accepted`.
- Session log: WHAT I BUILT / WHAT WORKS / WHAT'S LEFT / OPEN QUESTIONS, including the surrogate address used, pool addresses adopted, and the first shadow-stats output.

- [ ] **Step 1:** Write both ADRs and update `docs/adr/README.md` (rows 0008, 0009, status `accepted`, date 2026-07-17).
- [ ] **Step 2:** Update the phase-2 doc status/checkboxes and HANDOFF.md; write the session log.
- [ ] **Step 3:** Commit.

```bash
git add docs/adr/ docs/phases/phase-2-mainnet-shadow-mode.md docs/HANDOFF.md docs/sessions/2026-07-17.md
git commit -m "T34: ADR-0008 (structural send-disable) + ADR-0009 (realistic cost model) + phase/session docs"
```

- [ ] **Step 4: Start the 72-hour shadow run (owner Decision 5)**

Launch the Task 5 Step 4 command (with SURROGATE_OWNER) as a long-running background process. It is expected to outlive the session; the session log must note the start timestamp so `--since 72h` windows can be checked against it. Report interim stats via `npx tsx scripts/shadow-stats.ts --cluster mainnet-beta` rather than re-reading raw logs.

---

## Self-Review (performed at write time)

- **Spec coverage:** send-disable layers → Tasks 1–2; cost model → Task 3; probe/profile/first run → Task 4; surrogate → Task 5; stats incl. net-positive rate + latency percentiles → Task 6; Geyser + latency instrumentation → Task 7; ADRs/docs/72h kickoff → Task 8. Depth gate + money gates carried in Global Constraints. No gaps found.
- **Placeholder scan:** the two implementer NOTES (Raydium/Orca API field shapes; Yellowstone client API) are deliberate verify-at-runtime instructions for third-party surfaces this plan cannot pin from here, not TODOs. The geyser cpmm-reserve `throw` is an explicit, documented scope boundary (code-only deliverable; vaults need a live endpoint to wire and verify honestly).
- **Type consistency:** `CostBreakdown` shape identical across costs.ts, types.ts (`AttemptRecord["costs"]`), executor hook, and stats parser (strings after serialization). `sendEnabled` required in `ExecuteMeta` everywhere; `latency` optional everywhere. `GeyserTransport` matches FakeTransport and YellowstoneTransport.
