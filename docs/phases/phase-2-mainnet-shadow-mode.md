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
