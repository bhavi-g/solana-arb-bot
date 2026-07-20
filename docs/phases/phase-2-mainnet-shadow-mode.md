# Phase 2 — Mainnet Shadow Mode

## Status: IN PROGRESS — code complete (T27–T33); shadow run BLOCKED on
## owner venue decision (see 2026-07-17 session log BLOCKERS)

Build-task state (2026-07-17): (1) mainnet config profile ✔ (.env.example
Phase-2 block; ADR-0008 send-disable enforced at PHASE=2). (2) price feed ✔
code-ready — polling is cluster-agnostic; BUT the deepest mainnet Raydium
CPMM SOL/USDC pool failed the 100k-USDC depth gate ($429 TVL vs Orca's
$32.5M whirlpool), so the Raydium venue is undecided and no mainnet run has
started. (3) send path hard-disabled ✔ (ADR-0008, 3 layers + unsigned
shadow txs, tested). (4) tracking ✔ (costs on every record per ADR-0009;
scripts/shadow-stats.ts). (5) no Jito ✔ (tip is modeled accounting only).
Geyser gRPC source is code-complete but unrunnable until the owner
provides an endpoint (not on the Helius free tier). 72h run duration set
per owner (2026-07-17).

## Scope
Mainnet DATA only. No real transaction is ever submitted in this phase.
Goal: find out if the strategy detects real, profitable opportunities
before a single cent is risked.

## Prerequisites
- Read PROJECT_BRIEF.md and docs/phases/phase-1-devnet-mechanics.md
  (confirm its exit criteria are actually met).
- Read the latest session log in docs/sessions/.

## Build tasks
1. Add a mainnet config profile via .env switch only (no code fork). Use
   Helius mainnet RPC.
2. Swap the devnet price feed for real mainnet pool state on Raydium and
   Orca for SOL/USDC (optionally SOL/USDT). Keep polling unless Phase 1's
   interface makes WebSocket an easy upgrade.
3. Run detection continuously against REAL prices. Hard-disable the send
   path entirely — simulate every detected opportunity, log the simulated
   result, never submit a real transaction.
4. Track and report: opportunities detected per hour, average simulated
   net profit, simulated revert/failure rate.
5. No Jito, tips, or bundles yet — this phase only validates whether the
   core strategy finds anything real.

## Exit criteria
- [ ] Ran in shadow mode for [duration — set once Phase 1 results are in]
- [ ] Have real data on detection rate and simulated profit
- [ ] Explicit decision made (with data, not assumption) on whether to
      proceed to Phase 3

## End-of-phase output
Update session log with the four-part summary plus shadow-mode stats
(opportunities/hour, avg simulated profit, revert rate).

## Venue decision — 2026-07-17 (owner: Option 3, deliberate interim step)

The mainnet Raydium **CPMM** SOL/USDC venue is unusable for shadow mode:
the deepest CPMM SOL/USDC pool is `47hq28…YUp4` at **$429 TVL / 214 USDC**
(exhaustive probe, `scripts/probe-mainnet-pools.ts`), far under the
100k-USDC depth gate. Real Raydium SOL/USDC depth lives on AMM v4 / CLMM,
which this codebase does not decode.

**Owner chose Option 3: two-Orca-pool detection** — detect between two deep
Orca SOL/USDC whirlpools at different fee tiers — as a **deliberate,
documented interim venue** so the 72h shadow collection can begin on real
mainnet data now. This is NOT a silent scope-narrowing: it is a
stop-gap while the real cross-DEX venue is built.

Depth-verified pools (`scripts/probe-orca-pools.ts`, 2026-07-17; three
cleared the 100k-USDC gate, top two selected):
- `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` — tick spacing 4, 4 bps,
  $32.5M TVL, 7.74M USDC vault.
- `FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q` — tick spacing 2, 2 bps,
  $579k TVL, 109k USDC vault.
- (`HJPjoW…gndJ`, spacing 64 / 30 bps, 122k USDC, also cleared — spare.)

**Planned NEXT venue (not abandoned): Option 1 — a Raydium CLMM decoder**,
built after this Option-3 collection run, to restore the true cross-DEX
(Raydium-vs-Orca) arbitrage the strategy targets. CLMM is concentrated-
liquidity like Whirlpools, so detect.ts's whirlpool leg math is largely
reusable; the new work is the CLMM account decoder and swap-leg builder.

### Implementation gap found while starting Option 3 (must build first)
Option 3 is NOT a config change. Producing the net-profit / revert-rate
exit signal needs a *simulatable* two-whirlpool arb transaction, which
requires new code (tracked as the immediate next tasks):
1. A two-whirlpool polling source (current `PollingPriceSource` hardcodes
   Raydium CPMM decode for the first address and throws on a whirlpool).
2. Pool identity in the domain model (`ArbDirection` currently identifies
   venues by DEX name; both Orca pools share `orca-whirlpool`, so the tx
   builder cannot tell which pool to buy on).
3. A two-whirlpool tx builder (current builder is one CPMM leg + one
   whirlpool leg).
Until these land and a short live sim smoke-check confirms real
`shadow-simulated` records with computable net + zero sends, the 72h run
does not start (a detection-only run yields no net-positive rate — the
whole exit signal).

## Additional requirement (added after order-type/repo research)
- Every logged shadow opportunity must report NET profit after: priority
  fee, an assumed Jito tip (model as 50-60% of gross profit, since that's
  the documented competitive rate), both pool fees, and slippage/price
  impact on both legs — not just the raw price gap. Log both gross and
  net so we can see how much the "real cost" model changes the picture.
- Elevate the data-feed upgrade: attempt Yellowstone Geyser gRPC in THIS
  phase (not deferred to Phase 4), specifically to get a real
  route-detection latency number. This is now a phase-2 deliverable, not
  just infrastructure roadmap.
- Exit criteria addition: report the count/rate of opportunities that
  are net-positive AFTER full realistic costs, not just gross-positive.
  This number is the actual go/no-go signal for Phase 3.

## Run result — two-Orca venue (interim, documented negative finding)

**Run:** two-Orca shadow, `mainnet-beta`, `polling`, PHASE=2 (send
structurally disabled). Pools `Czfq3xZZ…44zE` (4 bps) vs `FpCMFDFG…o28Q`
(2 bps). Config: `TRADE_SIZE_QUOTE=100 USDC`,
`MIN_PROFIT_THRESHOLD_QUOTE=10000` (0.01 USDC), `SLIPPAGE_TOLERANCE_BPS=50`,
`POLL_INTERVAL_MS=1500`.
**Window analysed:** 2026-07-17T17:13:56Z → 2026-07-20T04:32:36Z (59.3 h,
ongoing), **28,469 cycles** (all `mainnet-beta`/`polling`; 258 earlier
Phase-1 devnet records in `attempts.jsonl` excluded by run-start filter).

**Result — ZERO signal:**
- **0 opportunities** (gross *or* net) across all 28,469 cycles — every
  cycle a correct `no-opportunity`.
- **0 sends** (shadow-mode integrity intact; ADR-0008 held).

**Interpretation — this is useful NEGATIVE DATA, not a failure.** The two
deep same-pair Orca pools stay tightly aligned (~0–2 bps gap) while a round
trip costs ~1 USDC in pool fees + slippage, so the price gap never clears
cost + threshold. This matches the venue-decision caveat recorded when
Option 3 was chosen as a *deliberate interim* venue: profitable
opportunities were expected to be rare-to-none. The pipeline itself is
verified healthy (28k clean cycles, correct decisions, zero sends) — the
absence of signal is a property of the venue, not a bug. It confirms the
need for the cross-DEX Option-1 (Raydium CLMM) venue — whose decoder
foundation is now built and merged (`ade7628`) — to produce the real
Phase-3 go/no-go signal.

**⚠️ Latency caveat:** `dataAgeMs` figures from this run are NOT
trustworthy and must not be cited. Under investigation: the metric as
computed measures intra-process receipt→detect handoff (≈0; p50=p95=0,
96.2% exactly 0), not data staleness relative to the chain, and it reads
≈0 for Geyser too — so it cannot serve the polling-vs-Geyser comparison
until redefined. Diagnosis + proposed fix pending owner review; no change
applied (fix requires restarting the live shadow).
