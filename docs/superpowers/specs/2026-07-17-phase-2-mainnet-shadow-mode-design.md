# Phase 2 Design — Mainnet Shadow Mode

Date: 2026-07-17. Status: **approved by owner** (all six decision points
answered; see Decisions at the end). Brainstormed via
superpowers:brainstorming; supersedes nothing — Phase 2 is new work.

## Goal

Run detection continuously against REAL mainnet SOL/USDC pool state,
simulate every detected opportunity, and log fully-costed results —
while making a real mainnet send **structurally impossible**, not merely
forbidden by convention. Collect the data that decides whether Phase 3
is worth attempting: the rate of opportunities that are net-positive
after realistic costs (priority fee, modeled Jito tip, both pool fees,
price impact/slippage on both legs), not just gross-positive.

## Non-goals

- No real transaction submission of any kind (that is the point).
- No Jito bundle construction, tips, or bundle submission — the tip is
  a MODELED accounting line only.
- No spending real money without explicit owner approval (no RPC tier
  upgrades; no wallet funding; Geyser endpoint procurement deferred).
- No CLMM/AMM-v4 decoder work unless the owner approves it after the
  CPMM depth check (Decision 6: stop and ask).

## 1. Structural send-disable (three independent layers)

All three layers would have to fail simultaneously for a send to occur.

**Layer 1 — config (`src/config.ts`).** New derived field
`sendEnabled: boolean` on `Config`. It is COMPUTED, never read from the
environment:

- `PHASE=2` → `sendEnabled = false`, unconditionally (devnet or mainnet
  — shadow is shadow).
- `PHASE>=3` → `loadConfig` THROWS: Phase 3 is not implemented, so this
  version of the codebase cannot send on mainnet at all. Enabling it
  later requires a deliberate code change plus an ADR, exactly like the
  Phase-1 mainnet guard.
- Presence of a `SEND_ENABLED` env var (any value) → `loadConfig`
  THROWS ("no such switch exists") — a tripwire against the obvious
  future "just add a flag" bypass.
- The existing guard (`phase < 2` + mainnet → refuse) stays untouched;
  Phase 1 devnet behavior is unchanged (`PHASE=1` → `sendEnabled=true`).

**Layer 2 — executor (`src/executor.ts`).** `execute()` receives
`sendEnabled` via `ExecuteMeta`. The flow is identical through
threshold re-check → mandatory `simulateTransaction` → CU measurement;
then, when `sendEnabled` is false, it logs a new
`AttemptAction: "shadow-simulated"` (full real simulation output,
measured CU, would-send CU limit, and the costs block from §3) and
returns. `rpc.sendRawTransaction` is unreachable in shadow mode — the
executor itself refuses, regardless of caller.

**Layer 3 — wiring (`src/main.ts`).** When `!cfg.sendEnabled`, the RPC
object handed to the executor gets a `sendRawTransaction` that throws
`SendDisabledError` instead of wrapping the real connection method —
the real send capability is never constructed. If it ever throws, Layer
2 was bypassed: loud crash, never a silent send. Startup banner:
`SHADOW MODE — send path structurally disabled (PHASE=2)`.

Tests pin all three layers: config derivation and both throw cases; an
executor spy proving `sendRawTransaction` is never invoked even for a
profitable, simulation-passing opportunity; the `shadow-simulated`
record shape. `sim.err !== null` still logs
`aborted-simulation-failed` — that is the revert-rate signal.

## 2. Simulation realism — surrogate-owner simulation (owner-approved B)

An unfunded wallet cannot pass `simulateTransaction` for a real swap
(no ATAs, no balance): every simulation would fail with wallet errors,
poisoning the revert-rate metric and preventing CU measurement (which
the priority-fee estimate needs). Therefore:

- Discover, live (never from memory), a large mainnet holder with both
  WSOL and USDC ATAs (probe script; e.g. walk
  `getTokenLargestAccounts` on the mints and intersect owners).
- Build the arb transaction UNSIGNED with that holder as owner/payer:
  `ArbBuildContext.payer` widens to `Keypair | PublicKey`; a
  `PublicKey` payer produces a signerless `VersionedTransaction`
  (default zeroed signatures).
- Simulate with `sigVerify: false` (already implied by
  `replaceRecentBlockhash: true`). The RPC skips signature checks in
  simulation; output is fully real (NEVER_DO: nothing mocked).
- Zero cost. Our own mainnet keypair (`keypairs/mainnet-shadow.json`,
  fresh, never the devnet key) is never funded.

## 3. Realistic cost model (`src/costs.ts`, new, pure, TDD)

Turns a detected opportunity plus simulation data into a fully-costed
record. Logs BOTH gross and net.

- `grossProfit = quoteOut − quoteIn`, straight from the real AMM curve
  math on both legs. Pool fees, price impact, and slippage are already
  inside this number — they are how the curve prices each swap, not
  separable subtractions. The module doc states this explicitly so it
  is not mistaken for a missing cost.
- Explicit subtractions to reach net:
  - **base tx fee** — existing ADR-0007 path (`getFeeForMessage` +20%
    headroom, converted to quote units per cycle).
  - **priority fee** — `cuLimit (measured from simulation) × cuPrice`;
    `cuPrice` from mainnet `getRecentPrioritizationFees` (median of
    recent, refreshed periodically) with a documented fallback
    constant. Converted to quote units the same way as the base fee.
  - **modeled Jito tip** — `tipFraction × grossProfit`, default
    `0.55` (owner-approved), configurable within [0.50, 0.60] via
    `JITO_TIP_FRACTION`. Accounting only: no tip is ever constructed,
    paid, or sent. Applied only when `grossProfit > 0`.
- `netProfit = grossProfit − baseFee − priorityFee − modeledJitoTip`.
- `AttemptRecord` gains a `costs` block:
  `{ grossProfit, baseFee, priorityFee, jitoTipModel, jitoTipFraction,
  netProfit }` on every shadow line.
- When simulation fails (no measured CU), log `grossProfit` plus a flag
  that net is uncomputable for that line — never a fabricated number.
- `detect.ts` stays pure and single-purpose (it finds the gross edge);
  all cost math lives in this one tested module, per the new
  PROJECT_BRIEF locked decision ("#1 documented failure mode:
  hardcoded/optimistic profit math").

## 4. Mainnet data feed

Two sources, both behind the existing `PriceSource` interface
(ADR-0006); no detection rewrite.

**Polling (runs now, Helius free tier).**
- Read-only `scripts/probe-mainnet-pools.ts` discovers and verifies a
  live Raydium CPMM SOL/USDC pool and an Orca Whirlpool SOL/USDC pool
  from decoded on-chain state (mints, decimals, liquidity) — addresses
  are never recalled from memory.
- KNOWN RISK: mainnet's deepest Raydium SOL/USDC liquidity is on
  AMM-v4/CLMM, which we do not decode. If the best CPMM pool is too
  shallow to be a realistic venue, STOP AND ASK the owner (Decision 6);
  no silent CLMM decoder, no silent Orca-only fallback.
- Config profile: documented Phase-2 block in `.env.example`
  (`PHASE=2`, `CLUSTER=mainnet-beta`, verified pool addresses, real
  USDC mint/decimals). The owner's `.env` is not edited; runs pass
  Phase-2 values as process env vars.
- `MAX_RPS ≤ 10` cap already enforced. No RPC tier upgrade without
  asking.

**Yellowstone Geyser gRPC (code lands now; runs later — owner
Decision 3).**
- New `GeyserPriceSource` implementing `PriceSource`, subscribing to
  the two pool accounts. New exact-pinned dependency
  (`@triton-one/yellowstone-grpc` or equivalent, same pinning
  convention as the rest of `package.json`).
- Endpoint via `GEYSER_ENDPOINT`/`GEYSER_X_TOKEN` env vars; absent →
  the source is unavailable and polling is used. NOT runnable until
  the owner sorts out an endpoint (Geyser is not on the Helius free
  tier; procurement is a stop-and-ask money item).
- Detection-latency instrumentation (works for both sources, honest
  about what polling can know): per opportunity record `dataAgeMs`
  (now − freshest snapshot's observed time) and `detectComputeMs`
  (duration of `detect()`); logged in the attempt record's `detail`.

## 5. Metrics (`src/stats.ts` pure + `scripts/shadow-stats.ts` CLI)

Offline analysis over `logs/attempts.jsonl` (the phase's system of
record — no new in-process machinery):

- opportunities/hour
- avg and median GROSS profit; avg and median NET profit
- gross-positive rate vs **net-positive-after-realistic-costs rate**
  (the phase's go/no-go signal for Phase 3)
- simulated revert/failure rate (`shadow-simulated` with
  `sim.err !== null` ÷ total shadow simulations)
- detection latency p50/p95 (`dataAgeMs`, `detectComputeMs`)
- filterable by time window and cluster

## 6. Execution order

1. Enforcement layers 1–3 + tests (merged before anything polls
   mainnet).
2. Cost model `src/costs.ts` + `AttemptRecord` extension + tests.
3. Mainnet probe → verified pools → Phase-2 env profile → first
   polling shadow run on the free tier.
4. Surrogate-owner simulation (signerless build + `sigVerify:false`).
5. Stats module + CLI.
6. `GeyserPriceSource` + latency harness (code only; not run).
7. ADR-0008 (structural send-disable), ADR-0009 (realistic cost model,
   incl. modeled-tip-is-accounting-not-execution), session log,
   phase-doc status updates.

## Exit criteria (per updated phase doc)

- 72 hours continuous shadow-mode logging (owner Decision 5).
- Real data on: opportunities/hour, gross and net profit distribution,
  net-positive-after-costs rate, revert rate, detection latency.
- Explicit, data-backed go/no-go recommendation for Phase 3.

## Owner decisions (2026-07-17)

1. 3-layer enforcement incl. hard `PHASE>=3` refusal — **approved**.
2. Simulation realism — **Option B (surrogate-owner)** approved.
3. Geyser — **build, don't procure/run**; owner will sort an endpoint.
4. Jito tip fraction — **0.55 default** confirmed.
5. Shadow-run duration — **72 hours** continuous.
6. Shallow mainnet CPMM pool — **stop and ask**; no pre-approved
   fallback.
