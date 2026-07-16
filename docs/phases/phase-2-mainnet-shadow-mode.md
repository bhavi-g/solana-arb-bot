# Phase 2 — Mainnet Shadow Mode

## Status: NOT STARTED (do not begin until Phase 1 exit criteria are met)

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
