# ADR-0012: Opportunity detection ported to Rust, Rust is now the live decision path

**Date**: 2026-10-28
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner)

## Context

ADR-0011 moved the on-chain minimum-out guard to Rust. The resume's
Rust claim deserved more than one guard function: the thing actually
worth calling "the detection module" is `src/detect.ts`'s `detect()` —
both-direction AMM math over a `PoolSnapshot` pair, fee/threshold
comparison, the gap-bps diagnostic — the function that decides, every
cycle, whether the bot has found anything.

## Decision

**Ported `detect()` in full to `rust/arb-math::detect`** — same
algorithm, same floor-division integer math, including the CPMM and
Whirlpool pricing it calls internally. Uses `num_bigint::BigInt`
throughout rather than `u64`/`u128`: these are off-chain estimation
quantities with no on-chain field-width ceiling to mirror (a Whirlpool's
Q64.64 sqrt price is a u128 on-chain, and squaring it for the gap
calculation needs up to 256 bits) — this is the deliberate counterpart to
ADR-0011's u64 guard math, not an inconsistency.

**`src/detect.ts` stays in the repo, unchanged, as the tested reference
implementation** — its original 10 tests keep passing. A new parity
suite, `tests/detect-rustmath.test.ts`, runs both implementations
against shared fixtures (10 cases pulled directly from
`tests/detect.test.ts`) and asserts identical decisions, including the
exact bigint amounts.

**`src/main.ts`'s live loop now calls `detectViaRust()`, not
`detect()`.** This is the actual decision made every polling cycle —
Rust is in the load-bearing path, not sitting next to it. `src/fee.ts`
still imports `midPriceNum`/`midPriceDen` from `src/detect.ts` for fee
conversion (unrelated to the decision itself) — left untouched.

## Alternatives Considered

### Alternative 1: Leave `detect()` in TS, keep Rust to the guard-math slice from ADR-0011
- **Pros**: Smaller, lower-risk change; `main.ts`'s orchestration (which
  has no automated test coverage of its own) stays untouched.
- **Cons**: Doesn't answer "where's the Rust" with the module that
  actually matters — a resume line naming Rust should point at the
  decision logic, not only a one-line arithmetic guard.
- **Why not**: addressed the "Why not" directly by building the parity
  suite first and only swapping the call site once it was green,
  containing the main-orchestration risk instead of avoiding the change.

### Alternative 2: Delete `src/detect.ts` once the Rust port is verified
- **Pros**: No duplicate implementation to keep in sync.
- **Cons**: Loses the independently-tested reference the parity suite
  checks the Rust port against; `fee.ts` depends on its exported
  `midPriceNum`/`midPriceDen` helpers.
- **Why not**: keeping both, cross-validated, is a stronger correctness
  story — a regression in either implementation fails a test, not an
  interview question.

## Consequences

### Positive
- The module named in the resume ("detection") is genuinely Rust in the
  live path, cross-validated against its own prior TS test suite.
- 21 `cargo test` cases now cover guard math and detection; 173 TS tests
  total, including a 10-case Rust/TS parity suite.

### Negative
- One more process spawn per polling cycle (detect is now also a
  subprocess call, same cost profile discussed in ADR-0011).
- Two implementations of the same algorithm to keep in sync — mitigated
  by the parity suite, not eliminated by it.

### Risks
- **Risk**: `main.ts` has no automated test coverage of its own, so a
  wiring mistake at the call site wouldn't be caught by `npm test`.
  **Mitigation**: `detectViaRust`'s signature and return shape are
  typechecked against the same `Decision`/`DetectParams` types
  `detect()` uses, and the parity suite proves the underlying Rust
  function matches TS behavior before the call site was ever changed.
