# ADR-0011: Safety-critical guard math ported to a Rust crate (arb-math)

**Date**: 2026-10-28
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner)

## Context

The sell-leg minimum-out guard (`src/txbuilder/index.ts`: `minQuoteOut =
opp.quoteIn + opp.minProfitThreshold`) is the one piece of arithmetic
this project's entire safety case rests on — it's what makes a stale
quote revert on-chain instead of executing a one-legged position (ADR-0005).
It, and the constant-product pricing it depends on (`src/math/cpmm.ts`),
were implemented only in TS `bigint`, which is correct but untyped
against the actual on-chain width: an SPL swap instruction's
`amountIn`/`minimumAmountOut` fields are `u64`. `bigint` can represent
values no real instruction ever could, so a bug that produces an
out-of-range amount would surface only at simulation/send time, not at
the type level.

Separately: the owner needs this project to genuinely contain Rust, not
decorative Rust, and under a hard time constraint (same day).

## Decision

**Ported the guard math and CPMM pricing math to a new crate,
`rust/arb-math`**, as pure `u64` functions (`min_quote_out`,
`cpmm_amount_out`) with checked arithmetic — overflow is a typed error,
never a silent wrap. 14 `cargo test` cases mirror `tests/cpmm.test.ts`'s
vectors exactly, plus Rust-specific overflow-boundary cases TS's
arbitrary-precision `bigint` can't exercise (e.g. `u64::MAX` reserves
overflowing the `u128` intermediate product).

**Exposed over a JSON-over-stdio CLI** (`arb-math-cli`), not a native
addon (napi-rs) or WASM: `src/rustmath.ts` builds the release binary on
first use (`cargo build --release`, cached thereafter) and calls it with
`execFileSync`, one process per call. `src/txbuilder/index.ts` now calls
`minQuoteOutViaRust()` instead of computing the sum inline — this is the
actual live call site building every transaction, not a parallel/unused
path.

**u64 amounts cross the JSON boundary as decimal strings**, not JSON
numbers: JS's `JSON.parse` numbers are IEEE-754 doubles (53 bits of safe
integer precision), short of `u64`'s 64, so a large reserve or trade size
would silently lose precision as a plain JSON number. `fee_bps` stays a
plain number since it's always ≤10,000. Parsing happens only at the CLI
boundary (`main.rs`); the library functions themselves take real `u64`.

## Alternatives Considered

### Alternative 1: napi-rs native addon (in-process FFI, no subprocess)
- **Pros**: No per-call process-spawn latency; the more typical pattern
  for perf-sensitive Rust-from-Node integration.
- **Cons**: Needs a native build toolchain wired into `npm install`
  (prebuild/postinstall scripts, platform-specific binaries), more moving
  parts to get right and more to explain if something breaks.
- **Why not**: this project already runs its polling loop on a
  multi-second cadence (ADR-0006), not a sub-100ms hot path — a
  synchronous subprocess call (single-digit ms) is negligible overhead
  here. Flagged as the natural next step if the detection loop ever
  becomes genuinely latency-sensitive.

### Alternative 2: WASM (compile the crate to wasm32, load in-process)
- **Pros**: No subprocess, no native toolchain requirement at install
  time, portable.
- **Cons**: `u64` doesn't round-trip through WASM's JS boundary any more
  cleanly than through JSON (same 53-bit ceiling without BigInt64Array
  plumbing); adds a wasm-bindgen toolchain for not much less complexity
  than the CLI approach, for a crate this size.
- **Why not**: the CLI boundary is simpler to read, test, and explain
  end-to-end for a crate of two functions.

### Alternative 3: Leave the guard math in TS, write Rust elsewhere (e.g. an unused standalone tool)
- **Pros**: Zero risk to the live execution path under time pressure.
- **Cons**: Decorative — Rust code that nothing in the running bot
  actually depends on isn't an honest answer to "show me where it's
  used."
- **Why not**: the whole point was for the Rust to be real and load-
  bearing, not a side file.

## Consequences

### Positive
- The safety-critical guard arithmetic is now overflow-checked at the
  type level in the language actually used for Solana on-chain programs,
  not just bigint arithmetic trusted to stay in range.
- `u64` matches the real on-chain field width, closing a class of bug
  (TS producing an amount no instruction could accept) that bigint can't
  catch by construction.
- 14 Rust unit tests plus a TS parity suite (`tests/rustmath.test.ts`)
  cross-validate the port against the exact vectors the TS version was
  already tested against.

### Negative
- One process spawn per `buildArbTransaction` call; fine at this
  project's polling cadence, would need revisiting (Alternative 1) if the
  detection loop ever runs sub-100ms end to end.
- A second toolchain (`cargo`) is now a build dependency, on top of Node.

### Risks
- **Risk**: `cargo` not installed / `cargo build` fails on a fresh
  machine. **Mitigation**: `ensureBuilt()` builds the release binary
  lazily and fails loudly with the real cargo error rather than silently
  falling back to a different (untested-at-that-call-site) calculation.
- **Risk**: TS and Rust implementations drift apart over time if only one
  side is edited. **Mitigation**: `tests/rustmath.test.ts` runs both
  implementations against shared vectors in CI-equivalent (`npm test`),
  so a divergence fails a test, not silently.
