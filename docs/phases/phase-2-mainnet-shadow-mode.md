# Phase 2 — Mainnet Shadow Mode

## Status: IN PROGRESS — venue decided and BUILT. The two-Orca interim run
## is done (42,323 cycles, zero signal — documented negative finding) and
## the cross-DEX `clmm-orca` venue is built, tested, and merged (`3964374`).
## Remaining is operational: cut the live shadow run over to `clmm-orca` to
## collect the real Phase-3 go/no-go signal, then capture ADR-0010.

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

## Phase-3 go/no-go bar — owner-set, recorded 2026-07-22 BEFORE the
## `clmm-orca` run's results are seen

Owner's decision rule, stated in advance of any `clmm-orca` data so it
can't be rationalized after the fact: **a few genuinely net-profitable
opportunities per day, consistently across multiple days** — not a single
lucky spike — before this is considered worth pursuing into Phase 3.

**What "net-profitable" means here, precisely** (see `src/detect.ts`,
`src/costs.ts`, `src/stats.ts`): a poll cycle is logged as
`decision:"opportunity"` only if the better direction's profit, net of a
simple estimated base tx fee, clears `MIN_PROFIT_THRESHOLD_QUOTE` (0.01
USDC) — this is a loose gate, NOT the number to judge the bar against.
Every such opportunity is then costed fully via `computeCosts()`: gross
profit − base fee − priority fee (from the live compute-unit price) −
modeled Jito tip (55% of gross, ADR-0009 — modeled only, never paid,
never sent). That produces `costs.netProfit`; `scripts/shadow-stats.ts`
reports how many of those clear zero as `netPositive` (count) and
`netPositiveRate` (fraction of opportunities). **The bar is judged against
`netPositive`, converted to a per-day rate**
(`netPositive / hours * 24`), not against the raw `opportunitiesPerHour`
figure, which only reflects the loose base-fee-only detect-time gate and
would overstate the signal.

**How this will be checked:** `npx tsx scripts/shadow-stats.ts --cluster
mainnet-beta --since <window>` gives `opportunities`, `netPositive`,
`netPositiveRate`, and `hours` for a given window. Multiple non-overlapping
`--since` windows (e.g. day-by-day) will be compared, not just the
cumulative total, to check for consistency vs. a one-off spike.

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

## Run result — two-Orca venue, FINAL (interim, documented negative finding)

**Run:** two-Orca shadow, `mainnet-beta`, `polling`, PHASE=2 (send
structurally disabled). Pools `Czfq3xZZ…44zE` (4 bps) vs `FpCMFDFG…o28Q`
(2 bps). Config: `TRADE_SIZE_QUOTE=100 USDC`,
`MIN_PROFIT_THRESHOLD_QUOTE=10000` (0.01 USDC), `SLIPPAGE_TOLERANCE_BPS=50`,
`POLL_INTERVAL_MS=1500`. Started 2026-07-17T17:13:37Z, closed at its
scheduled 72h mark 2026-07-20T17:13:37Z.
**Window analysed (full, closed):** 2026-07-17T17:13:56Z →
2026-07-20T17:03:05Z (71.8 h), **42,323 cycles** (all
`mainnet-beta`/`polling`; 313 out-of-window records — earlier Phase-1
devnet plus a handful just past the formal close — excluded by the
run-window filter). Frozen dataset: `logs/attempts-72h-two-orca.jsonl`.

**Result — ZERO signal, confirmed at full window close:**
- **0 opportunities** (gross *or* net) across all 42,323 cycles — every
  cycle a correct `no-opportunity`.
- **0 sends** (shadow-mode integrity intact; ADR-0008 held) — confirmed
  end-to-end, from run start through graceful SIGINT shutdown.

**Interpretation — this is useful NEGATIVE DATA, not a failure.** The two
deep same-pair Orca pools stay tightly aligned (~0–2 bps gap) while a round
trip costs ~1 USDC in pool fees + slippage, so the price gap never clears
cost + threshold. This matches the venue-decision caveat recorded when
Option 3 was chosen as a *deliberate interim* venue: profitable
opportunities were expected to be rare-to-none. The pipeline itself is
verified healthy (42k clean cycles, correct decisions, zero sends) — the
absence of signal is a property of the venue, not a bug. It confirms the
need for the cross-DEX Option-1 (Raydium CLMM) venue — whose decoder
foundation is built and merged (`ade7628`), and whose `swap_v2` tx-builder
foundation is now in design (spec: `docs/superpowers/specs/
2026-07-20-raydium-clmm-swapv2-builder-design.md`) — to produce the real
Phase-3 go/no-go signal.

**✅ Latency metric — FIXED.** The `dataAgeMs` bug flagged mid-run is
resolved and merged (`19975fd`, merged to master at window close in
`8077933`). Root cause: the field (then `fetchedAtMs`) was stamped by each
source *after* the RPC round-trip completed, and `onPair` ran
synchronously — so the metric measured a sub-millisecond receipt→detect
handoff (≈0; the 71.8h run showed p50=p95=0, 96.4% exactly 0), not data
staleness, and it would have read ≈0 for Geyser too, defeating the planned
polling-vs-Geyser comparison. Fix: the field is renamed
`fetchStartedAtMs` and is now stamped immediately *before* the batch RPC
read in both polling sources; the derived record field is renamed
`dataAgeMs` → `handoffMs` (acquisition→decision latency — RPC round-trip
+ decode + detect for polling, ~0 for a push source). Documented as NOT
capturing poll-interval sampling lag (a separate, deferred metric).
**Live-verified working** immediately after the restart below: `handoffMs`
values are real and varied (e.g. 49, 55, 121, 149, 293, 1416 ms) instead
of flooring to 0.

**Restart:** a fresh two-Orca run started 2026-07-20T17:20:33Z on the
corrected code (same pools/config as above), logging to
`logs/shadow-run-2-corrected.log`
(marker: `logs/shadow-run-2.start`). `logs/attempts.jsonl` continues to
accumulate across the restart (the closed window's records are preserved
separately in `logs/attempts-72h-two-orca.jsonl`; any future analysis of
the new run should filter `timestamp >= 2026-07-20T17:20:33Z`).
