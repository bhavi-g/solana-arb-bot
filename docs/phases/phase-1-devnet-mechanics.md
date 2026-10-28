# Phase 1 — Devnet Mechanics

## Status: DONE — all exit criteria met, including a verified live on-chain send
(evidence in docs/sessions/2026-07-16-phase1-finish.md; live send verified
finalized on-chain 2026-07-16, see the exit-criteria table below)

## Scope
Devnet only. No mainnet, no Jito, no real money. Goal: build the bot's
core mechanics correctly and prove they work end-to-end on fake funds.

## Prerequisites
- Read PROJECT_BRIEF.md in full before starting this phase.
- If docs/adr/ isn't initialized, initialize it first (see ADR list below).
- If docs/sessions/ isn't initialized, initialize it.

## ADRs to draft and get approved before/while building
- TypeScript + @solana/web3.js as the stack
- Helius as RPC provider
- "processed" commitment level for arbitrage (reverts atomically anyway,
  so confirmed/finalized only add latency, not safety)
- Config-switched devnet/mainnet (never a code fork)
- Mandatory simulateTransaction before every send
- Polling now, with a clean interface boundary so gRPC/WebSocket can
  replace it later without a rewrite

## Build tasks
1. Scaffold TypeScript project with @solana/web3.js and the Helius SDK.
2. All config in .env: RPC URL, cluster, keypair path, token pair,
   min-profit threshold, slippage tolerance. Devnet/mainnet is a config
   switch only, never a code change.
3. Load/generate a devnet keypair from .env. Never hardcode keys.
4. Price-scanning module: poll SOL/USDC pool prices on Raydium (CPMM) and
   Orca (Whirlpool). Interface must cleanly separate the data source from
   detection logic downstream, so it can later be swapped for WebSocket or
   Yellowstone gRPC.
5. Opportunity-detection function: calculate cross-DEX price gap using
   correct constant-product AMM math (x*y=k), subtract estimated fees and
   slippage, flag profitable only if net margin clears the configurable
   minimum threshold.
6. Transaction-builder: construct ONE atomic transaction containing both
   legs (buy cheap DEX, sell expensive DEX).
7. MANDATORY simulateTransaction before any submission. Abort on failure
   or non-profit. Measure compute units from simulation, don't guess the
   budget.
8. Use "processed" commitment level throughout (reads and confirmations).
9. Structured logging for every attempt: timestamp, detected gap, simulated
   result, submitted-or-aborted, and why.
10. README: how to run on devnet with faucet SOL.
11. Write tests for the opportunity-detection math and the abort-on-failed-simulation path before/alongside implementation (TDD).
12. Respect Helius free-tier limit of 10 requests/second — build polling with this ceiling in mind, with backoff if approached.

## Process rules
- Brainstorm/clarifying questions first, then a design doc shown in
  readable chunks, then wait for explicit approval before writing any code.
- Check each checkpoint diff before approving the next task.
- Commit after each completed task, not only at session end.

## Exit criteria (all must be true to move to Phase 2)
- [x] Bot runs on devnet without errors
      (evidence: 2026-07-16 synthetic + live polling runs, session log)
- [x] Correctly detects at least one synthetic/test arbitrage opportunity
      (evidence: synthetic −300bps cycle detected; ALSO a live devnet
      −2954bps gap detected on real pools — session log JSONL excerpts)
- [x] Every send path goes through simulateTransaction first
      (evidence: single gate in src/executor.ts, grep-verified only
      sendRawTransaction call site; 5 abort-path unit tests. NOW ALSO
      exercised live: 8 real devnet sends on 2026-07-16, each simulated
      before send, all finalized err:null — first sig
      51RYVhyLPSJ6g7rFezVdB7gt3QijVnzuhGGWqygmb9rcgXXgWPcf2HogWNAB4R28noLxLJY9K9MaRByYsJ23R5HQ)
- [x] Every attempt (sent, aborted, reverted) is logged
      (evidence: logs/attempts.jsonl from both runs; sent/send-failed
      variants pinned by unit tests; the 8 live sends logged with real
      signatures)
- [x] A real atomic arb transaction lands on devnet (the final gap-closer)
      (evidence: bot ran against our seeded Raydium pool 2yYGrgM… (138
      devUSDC/SOL) vs deep Orca pool 3KBZiL2g… (~22); 8 sends finalized
      err:null; wallet devUSDC +0.288 net; Raydium price moved 138→28.95 as
      the arb closed the gap — session log 2f)
- [x] Data-source / detection / execution / logging are cleanly separated
      modules (verified by checking the code, not just claimed —
      src/main.ts is the sole wiring point; detection is pure)

## End-of-phase output
Update docs/sessions/<date>.md with: WHAT I BUILT / WHAT WORKS / WHAT'S
LEFT / OPEN QUESTIONS OR BLOCKERS. Mark this file's Status as DONE only
once all exit criteria are checked off.
