# ADR-0005: Mandatory simulateTransaction before every send

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md)

## Context

Between detecting a gap and landing a transaction, pool state moves. Sending blind means paying fees for transactions that were already doomed when they left our machine, and — worse — it means our compute-unit budget is a guess. simulateTransaction executes the exact transaction against current state on the RPC node and returns success/failure, logs, and units consumed, for the cost of one RPC call. PROJECT_BRIEF.md and NEVER_DO.md both make this mandatory; this ADR records *why* and pins the implementation shape.

## Decision

Every send path goes through a single executor function that (1) simulates the exact signed transaction, (2) aborts and logs if simulation errors OR if simulated outcome is below the min-profit threshold after fees, (3) takes the compute-unit budget from the simulation's unitsConsumed (with a safety margin) rather than guessing, and (4) only then sends. There is deliberately no second code path that reaches sendTransaction; tests assert the abort behavior.

## Alternatives Considered

### Alternative 1: Send optimistically, let atomic revert handle failure
- **Pros**: Saves one RPC round-trip (~50–200ms) per attempt — real competitive bots do trade this off.
- **Cons**: Pays the base fee on every doomed send; no compute-unit measurement, so budgets are guessed (overpay or get program-failure on exhaustion); floods our own logs with noise that Phase 1 is supposed to keep interpretable.
- **Why not**: In Phase 1 (and by project rule, all phases) correctness and interpretability beat the latency saving. If Phase 4 data ever shows the simulate round-trip losing us races, that's a project-owner decision to revisit — not something code quietly skips.

### Alternative 2: Simulate only when detection confidence is low
- **Pros**: Hybrid latency/safety.
- **Cons**: Introduces a judgment heuristic exactly where NEVER_DO demands an invariant; two send paths to test and audit instead of one.
- **Why not**: An invariant that holds "usually" is not an invariant. One gate, one path, always.

## Consequences

### Positive
- Doomed transactions cost one RPC call, not an on-chain fee.
- Compute-unit budgets are measured per-transaction, satisfying the "never guess the budget" rule.
- Single choke point makes the NEVER_DO rules testable: unit tests mock a failed simulation and assert send is never called.

### Negative
- Adds one RPC round-trip of latency per attempt and consumes rate-limit budget (accounted for in the 10 req/s scheduler).
- Simulation runs against the RPC node's view, which can differ from the leader's state at execution — a passing simulation is necessary, never sufficient. Atomic revert remains the true backstop.

### Risks
- Risk: future refactor accidentally introduces a direct sendTransaction call. Mitigation: tests pin the gate; code review checks that `sendRawTransaction`/`sendTransaction` appears nowhere outside the executor module.
