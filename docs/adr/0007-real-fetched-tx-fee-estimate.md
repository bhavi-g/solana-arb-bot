# ADR-0007: Real fetched tx fee estimate, converted to quote units per cycle

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner); drafted by Claude during a
superpowers:brainstorming session, reviewed and accepted by the owner
before implementation (unlike ADRs 0001–0006, which were pre-authorized to
write as accepted unattended — this one the owner explicitly reviewed first)

## Context

`EST_TX_FEE_QUOTE` has defaulted to a hardcoded `1000` quote-token base
units since Phase 1 began, with no basis in reality — flagged as an OPEN
QUESTION in `docs/sessions/2026-07-16.md` and deferred.

Two things make this non-trivial to just "fix with a number":

1. The fee Solana actually charges is paid in **lamports (SOL)** — SOL is
   also our pair's *base* token (SOL/devUSDC). But `detect.ts`'s profit
   math (`estNetProfit = quoteOut - quoteIn - estTxFeeQuote`) is entirely
   in **quote-token (devUSDC) units**. Getting a real fee number and
   getting it into the right currency are two separate problems.
2. This must stay clearly distinct from `MIN_PROFIT_THRESHOLD_QUOTE` — the
   owner-configured bar for "is this worth bothering with," compared
   *after* `estTxFeeQuote` is already subtracted (`src/detect.ts:97`,
   `:55`). Any headroom/margin applied to the fee estimate must live only
   inside the fee number itself, never bleed into or get confused with
   the threshold comparison.

## Decision

**1. Get the real fee, once, at startup.** Build the actual swap
transaction shape (same instructions `executor.ts` would send) against
the live pool state already fetched during setup, and call
`connection.getFeeForMessage()` on devnet to get the true lamport cost for
exactly that transaction (correct signature count, no assumptions).
Fallback if the RPC call fails or returns null: the known Solana protocol
constant (5000 lamports × signature count), so a transient RPC hiccup at
startup can never hard-fail the bot.

**2. Apply headroom to the fee estimate only, once, immediately after
fetching it — before any unit conversion, and nowhere near the
threshold.** A fixed **+20%** multiplier is applied directly to the
fetched-lamports number:

```
feeLamportsWithHeadroom = fetchedFeeLamports * 1.20
```

This headroom exists solely to absorb minor real-world fee variance (e.g.
a priority-fee instruction added in a later phase). It is **not** the
min-profit threshold, is never added to `MIN_PROFIT_THRESHOLD_QUOTE`, and
the two numbers are never combined into one. The full chain stays:

```
estTxFeeQuote        = convertToQuote(feeLamportsWithHeadroom, livePrice)   // cost estimate
estNetProfit          = quoteOut - quoteIn - estTxFeeQuote                    // detect.ts:97, unchanged
decision "opportunity" iff estNetProfit >= minProfitThresholdQuote          // detect.ts:55, unchanged
```

`minProfitThresholdQuote` is compared against `estNetProfit` exactly as it
is today; it never sees or touches the headroom.

**3. Convert to quote units fresh every polling cycle**, using that
cycle's live mid-price. The mid-price calculation already exists as a
private helper inside `detect.ts` (`midPriceNum`/`midPriceDen`) — it will
be exported and reused here rather than duplicated, so there is one source
of truth for "what is the price." `detect.ts`'s `DetectParams` interface
is unchanged (`estTxFeeQuote: bigint`, still just a number handed in); its
9 existing unit tests are unaffected. `main.ts` computes the fresh value
before each `detect()` call, using the snapshot pair it already has —
no extra RPC call, one multiplication per cycle.

**4. `EST_TX_FEE_QUOTE` stays as an explicit manual override.** If set in
`.env`, it skips live fetch/conversion/headroom entirely and is used
as-is — for testing or manual tuning. `.env.example` will document that
this is an override, not a tuning knob on top of the computed default.

## Alternatives Considered

### Alternative 1: Static quote-unit default computed once at startup (no per-cycle repricing)
- **Pros**: Simpler; matches today's single-config-value shape.
- **Cons**: Goes stale if the SOL/devUSDC price drifts meaningfully during
  a long-running session — the fee estimate silently becomes wrong.
- **Why not**: Per-cycle repricing costs one multiplication and zero extra
  RPC calls (the price is already fetched every cycle for detection
  itself). Free to keep correct; PROJECT_BRIEF's "correct first" mission
  says do it.

### Alternative 2: Track the comparison in lamports instead of quote units
- **Pros**: Fee and threshold would share one currency (SOL), removing a
  conversion.
- **Cons**: `MIN_PROFIT_THRESHOLD_QUOTE` is explicitly owner-configured in
  quote-token terms, and trade size / threshold / all logging are
  quote-denominated throughout the project. Converting the *threshold*
  into lamports needs the same live-price conversion anyway, just moved to
  the other side of the comparison, and would touch `detect.ts`'s tested
  interface.
- **Why not**: Fewer changes, no interface breakage, keeps the one
  owner-facing currency (devUSDC) that trade size and threshold already
  use.

### Alternative 3: Hardcode 5000 lamports/signature, skip the RPC call
- **Pros**: No RPC dependency at startup.
- **Cons**: Doesn't verify against live devnet reality — the exact failure
  mode this ADR exists to fix (the current default already *is* an
  unverified assumption). Wouldn't naturally extend if a priority-fee
  instruction is added later.
- **Why not**: The owner explicitly asked for a default "derived from real
  fetched devnet fee data." `getFeeForMessage` is one call at startup
  only (not per-cycle) — negligible against the 10 req/s budget.

## Consequences

### Positive
- Fee estimate reflects real devnet reality instead of an arbitrary guess.
- Stays accurate through long sessions as price moves, at effectively zero
  extra RPC cost (one multiply per cycle).
- `detect.ts`, its 9 tests, and the executor's simulate-gate are
  untouched — blast radius is `config.ts`, `main.ts`, and one new
  exported pure helper.
- Headroom and threshold remain provably separate concepts in the code,
  not just in this document.

### Negative
- One additional startup RPC call and one extra per-cycle multiplication —
  small but new surface area.
- The mid-price conversion doesn't account for the (negligible) slippage
  the fee amount would itself incur if it were actually swapped — accepted
  as a cost *estimate*, not an executed trade.

### Risks
- **Risk**: `getFeeForMessage` returns null/errors under some devnet
  conditions (e.g. a stale blockhash on the sample message). **Mitigation**:
  documented fallback to the protocol constant; never hard-fails startup.
- **Risk**: a later phase adds a priority-fee instruction, changing the
  fee's shape. **Mitigation**: the +20% headroom partially absorbs this
  now; flagged here so a future ADR revisits it when priority fees are
  actually added.
