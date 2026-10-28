# ADR-0010: Raydium-CLMM-vs-Orca cross-DEX venue — tested, zero signal; Phase 2 concludes with no venue clearing the go/no-go bar

**Date**: 2026-07-26
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner); run stopped and result accepted on
owner instruction 2026-07-26 ("second, complete, confirmed zero-signal
finding... no reason to keep running longer, the trend never moved")

## Context

`clmm-orca` (Raydium CLMM SOL/USDC vs Orca whirlpool SOL/USDC,
cross-DEX) was built, tested, and merged specifically to produce the real
Phase-3 go/no-go signal, after the two-Orca same-pair venue was run to
completion as a deliberate interim step and returned zero signal
(documented in `docs/phases/phase-2-mainnet-shadow-mode.md`, "Run result
— two-Orca venue, FINAL"). The owner recorded the go/no-go bar in advance
of any `clmm-orca` data (2026-07-22, same file, "Phase-3 go/no-go bar")
specifically so the result couldn't be rationalized after the fact: **a
few genuinely net-profitable opportunities per day, consistently across
multiple days**, judged against `netPositive` from `scripts/shadow-stats.ts`
(full realistic costs — base fee, priority fee, modeled Jito tip), not
the looser `opportunitiesPerHour` detect-time gate.

## Decision

Accept the `clmm-orca` run's result as a second, complete, confirmed
zero-signal finding, and close Phase 2 with an explicit no-go conclusion
on the strategy as currently scoped (SOL/USDC, these two venues, no
Jito/priority-fee competition modeling beyond ADR-0009's estimate).

**Run:** `shadow-run-3-clmm-orca`, `mainnet-beta`, `polling`, PHASE=2
(send structurally disabled, ADR-0008). CLMM pool
`3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv` (Raydium CLMM SOL/USDC,
4 bps, $5.9M TVL) vs Orca whirlpool
`Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` (4 bps, $32.5M TVL).
`TRADE_SIZE_QUOTE=100 USDC`, `MIN_PROFIT_THRESHOLD_QUOTE=10000` (0.01
USDC), `SLIPPAGE_TOLERANCE_BPS=50`. Started `2026-07-22T13:58:56Z`,
stopped `2026-07-26T02:41:13Z` via graceful `SIGINT` (`stopping after
current cycle…` → `source finished; exiting.`).

**Window analysed (full, closed):** `2026-07-22T13:58:57Z` →
`2026-07-26T02:41:13Z`, **84.7 hours**, **55,245 cycles**, all
`mainnet-beta`/`polling`.

**Result — ZERO signal, confirmed at full window close:**
- **0 opportunities** (gross or net) across all 55,245 cycles — every
  cycle a correct `no-opportunity`.
- **0 sends** (shadow-mode integrity intact end-to-end; ADR-0008 held).
- Latency healthy throughout: `handoffMs` p50 53ms / p95 156ms.
- No simulation failures.

The run comfortably exceeded the "at least 72 hours" floor the owner set
when it was launched (84.7h vs. 72h), and the signal never moved in that
extra ~13 hours — the last day's data looks the same as the first.

## Alternatives Considered

### Alternative 1: Keep the run going indefinitely, hoping for a spike
- **Pros**: More hours of data; would catch a rare, late-arriving signal
  if one existed.
- **Cons**: The go/no-go bar explicitly requires *consistency*, not a
  single lucky spike — an isolated late hit wouldn't clear the bar
  anyway. 84.7h of flat zero, on a venue chosen specifically because it
  crosses two independently-priced DEXes (unlike the two-Orca same-pair
  case), is already a strong negative result.
- **Why not**: No trend to wait out. The owner's instruction to stop is
  consistent with the bar's own logic — running longer only produces more
  of the same zero, at compute/API cost for no new information.

### Alternative 2: Try additional venues/pairs before concluding Phase 2
- **Pros**: SOL/USDC on these two specific pools might just be an
  unusually efficient pair; other pairs or venues could behave
  differently.
- **Cons**: Out of scope for what was authorized — Phase 2 was built and
  budgeted around validating the strategy on SOL/USDC across the two
  best-available deep venues (CPMM was ruled out for insufficient depth,
  ADR-adjacent finding in the phase-2 doc). Expanding pairs/venues is a
  new scope decision requiring explicit owner sign-off, not something to
  infer from "the first two attempts failed."
- **Why not**: Not decided here. Left as an open question for the owner
  if they want to pursue a broader search in a future phase.

## Consequences

### Positive
- Phase 2's actual question — "does this strategy find real, profitable
  opportunities on mainnet before any capital is risked" — now has a
  clear, data-backed answer: **no, not on either tested venue.** That is
  a genuinely useful outcome; it prevents proceeding to Phase 3 (real
  capital, real sends) on an unvalidated premise.
- The negative finding is symmetric and consistent across two
  structurally different venues (same-pair vs. cross-DEX), which
  strengthens confidence this reflects real market efficiency at this
  trade size/pair rather than a one-off artifact of either venue's
  specific pool pair.
- The pipeline itself is fully verified healthy across ~97,000 combined
  cycles between the two runs (two-Orca + clmm-orca): correct decisions,
  zero sends, stable latency. Any future venue/pair expansion inherits a
  proven-correct detection/costing/logging stack.

### Negative
- No profitable opportunity was ever observed end-to-end, so the realistic
  cost model (ADR-0009) and the executor's `opportunity`-branch logic
  remain unexercised against a real detected opportunity — only against
  `no-opportunity` cycles and the earlier synthetic/devnet cases.
- Two full mainnet shadow runs (two-Orca ~116h combined, clmm-orca 84.7h)
  consumed RPC quota and operator attention for a result that, in
  hindsight, an a-priori liquidity/spread analysis might have anticipated
  for such deep, heavily-arbed pools.

### Risks
- If a future session revisits this strategy on the same pair/venues
  without re-reading this ADR, it risks re-running the same experiment
  and burning the same time for the same answer. Any future attempt
  should target a materially different pair, venue, or trade size, and
  say explicitly why that changes the expected outcome.
