# ADR-0009: Realistic cost model — gross AND net on every shadow record

**Date**: 2026-07-17
**Status**: accepted
**Deciders**: Adish (project owner); requirement added by the owner after
order-type/open-source-bot research ("the #1 documented failure mode in
comparable open-source bots [is] hardcoded/optimistic profit math"),
design approved 2026-07-17

## Context

Phase 2's exit signal is no longer "did we detect gross-positive gaps"
but "what fraction of opportunities survive REALISTIC costs" — priority
fee, a competitive Jito tip, both pool fees, and both legs' price
impact/slippage. Logging only raw price gaps would overstate the edge
exactly the way failed open-source bots do.

## Decision

A single pure module, `src/costs.ts`, computes a `CostBreakdown` attached
to every executor record for an opportunity (`shadow-simulated` and
`aborted-simulation-failed`):

1. **`grossProfit = quoteOut − quoteIn`**, straight from the AMM curve
   math on both legs. Pool fees, price impact, and the whirlpool slippage
   haircut are ALREADY inside these amounts — they are how
   `detect.ts`/`src/math` price each swap — so they are not (and must not
   be) subtracted again.
2. **Explicit subtractions** for costs the curve cannot see:
   - **Base tx fee**: the ADR-0007 value (live `getFeeForMessage` +20%
     headroom, converted to quote units per cycle).
   - **Priority fee**: `ceil(wouldSendCuLimit × cuPrice / 1e6)` lamports,
     converted to quote units via the same mid-price math as ADR-0007.
     `cuPrice` is the median of `getRecentPrioritizationFees` samples
     with zeros filtered (many slots carry zero-fee txs; including them
     underestimates timely inclusion — we prefer to overestimate costs),
     cached 30s, fallback constant 1000 µlamports/CU.
   - **Modeled Jito tip**: `0.55 × grossProfit` when gross is positive
     (env `JITO_TIP_FRACTION`, clamped to the owner band [0.50, 0.60]).
     **Accounting only** — Phase 2 constructs no bundle, pays no tip,
     touches nothing Jito. The model answers one question: would this
     edge survive a competitive tip?
3. **`netProfit = gross − baseFee − priorityFee − jitoTip`**; when
   simulation fails there is no measured CU, so `priorityFee` and
   `netProfit` are `null` with `netComputable: false` — never a
   fabricated number (docs/NEVER_DO.md).
4. Both gross and net are logged on every record (`costs` block in
   `AttemptRecord`); `scripts/shadow-stats.ts` reports gross-positive vs
   net-positive rates, the latter being the Phase-3 go/no-go signal.

## Alternatives considered

- Subtracting pool fees/slippage as separate line items — double-counts
  costs the curve math already applied; rejected.
- A flat "costs" constant — exactly the hardcoded-optimistic-math failure
  mode this ADR exists to prevent; rejected.
- Computing net only for simulation-passing records — loses gross data on
  reverts; instead gross is always logged and net is null when honest
  computation is impossible.

## Consequences

- `detect.ts` stays a pure gross-edge finder; all cost realism lives in
  one tested module (`tests/costs.test.ts`).
- The min-profit threshold comparison (NEVER_DO) is untouched — the cost
  model is reporting, not gating. If Phase 2 data shows the threshold
  should incorporate priority fees, that is a future owner decision.
- The 0.55 tip fraction is a model assumption, revisited when Phase 3+
  measures real bundle acceptance.
