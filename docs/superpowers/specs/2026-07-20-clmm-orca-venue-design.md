# Raydium CLMM ↔ Orca cross-DEX venue — design

**Status:** approved (design), pre-implementation
**Date:** 2026-07-20
**Context:** Phase 2 / Option 1 — the follow-up that wires the two merged
CLMM foundations into a runnable cross-DEX shadow venue. The decoder
foundation (`src/decode/clmm.ts`, merged `ade7628`) gave the read side;
the swap_v2 builder (`src/txbuilder/raydiumClmm.ts`, merged `659716f`)
gave the write-side primitive. This spec assembles them into the atomic
arb transaction, a polling source, and the `VENUE="clmm-orca"` wiring —
the venue that can finally produce a real cross-DEX go/no-go signal (the
two-Orca interim produced zero, as expected).

## Scope

**End state of THIS spec (owner decision):** code-complete + a two-leg
mainnet **simulation** smoke-check green, typecheck/tests green. The
actual go/no-go shadow run, and cutting the live `shadow-run-2` process
over from two-Orca to `clmm-orca`, are a **separate operational step
after merge** — not part of this deliverable. This matches the discipline
of the two prior CLMM specs (each stopped at code + smoke-check).

**In scope:**

- `src/txbuilder/clmmOrca.ts` — `buildClmmOrcaArbTransaction`, one atomic
  tx with a CLMM leg (`buildClmmSwapV2Ix`) + an Orca leg
  (`buildWhirlpoolSwapIx`) sharing the owner's SOL/USDC ATAs.
- `src/datasource/clmmOrcaPolling.ts` — `ClmmOrcaPollingSource`, one batch
  read of `[clmmPool, whirlpool]` per cycle → `SnapshotPair`.
- `src/main.ts` — `setUpClmmOrca` + the `venue === "clmm-orca"` dispatch
  branch.
- `src/config.ts` — `venue` union extension, CLMM program-id +
  pool-address config, per-venue required-key validation.
- `scripts/smoke-clmm-orca-arb-sim.ts` — read-only mainnet simulation of
  the atomic two-leg tx against both live programs.
- `tests/clmmOrca.test.ts`, `tests/clmmOrcaPolling.test.ts`.
- `.env.example` — a documented `clmm-orca` block.

**Out of scope (documented forward notes below):** the shadow run + its
go/no-go analysis; ADR-0010; the `handoffMs` latency-metric fix; any
unification refactor of the three arb-tx builders; Geyser support for
this venue.

## Approach (chosen: dedicated files mirroring the two-Orca venue)

Three new files, each a direct analog of an existing one, plus the
unavoidable additive wiring edits. Rejected alternatives: (B) generalize
`index.ts`/`twoWhirlpool.ts` into one leg-abstracted builder — touches the
working `cpmm-orca`/two-Orca paths, risky while a shadow is live, against
the isolation spirit both prior specs held; (C) fold CLMM into the
two-Orca source as "N heterogeneous pools" — that source is hard-wired to
two whirlpool decoders and would be muddied by heterogeneous
decoders/orientation. Dedup of the three builders is a deferred candidate
once the venue is proven.

## Architecture & data flow

Same shape as the two-Orca venue, one heterogeneous swap:

```
config.ts (VENUE="clmm-orca")
   → main.ts setUpClmmOrca()
        ├─ startup: read CLMM pool once → state.ammConfig → read ammConfig
        │           → decodeClmmAmmConfigFeeBps → cache feeBps
        ├─ startup: read Orca whirlpool once → static state (vaults, mints, tickSpacing)
        ├─ ClmmOrcaPollingSource (per cycle: 1 batch read [CLMM pool, Orca pool] → SnapshotPair)
        └─ buildTx → buildClmmOrcaArbTransaction (CLMM leg + Orca leg, shared ATAs)
   → detect() [unchanged] → execute() [unchanged] → logger [unchanged]
```

`SnapshotPair` slots stay cosmetic (as in `orcaOrcaPolling.ts`): CLMM
fills the `cpmm` slot, Orca fills the `whirlpool` slot. Both are
`kind:"whirlpool"` snapshots — `toClmmSnapshot` already produces that for
CLMM with `dex:"raydium-clmm"` — so `detect` consumes them unchanged and
tags direction by `dex`. Nothing in `detect.ts`, `costs.ts`, `fee.ts`,
`executor.ts`, or the existing venue builders changes.

## `buildClmmOrcaArbTransaction` — the atomic tx

New file `src/txbuilder/clmmOrca.ts`, structural analog of
`buildArbTransaction` in `index.ts`. One boolean picks the buy leg;
because the two snapshots carry **different** `dex` values
(`raydium-clmm` vs `orca-whirlpool`), `buyOn`/`sellOn` disambiguate the
legs directly — no pool-address matching (unlike two-Orca, where both
legs share a DEX):

```ts
const buyLegIsClmm = opp.direction.buyOn === "raydium-clmm";
const minQuoteOut = opp.quoteIn + opp.minProfitThreshold;
```

### CLMM leg (`buildClmmSwapV2Ix`)

Base = SOL = `mint_0` (orientation NORMAL, verified live on
`3ucNos4…`). The one boolean drives everything:

- Buy SOL = input quote (USDC = `mint_1`) → `inputIsToken0 = false`.
- Sell SOL = input base (SOL = `mint_0`) → `inputIsToken0 = true`.

This is exactly the CPMM leg's
`inputIsToken0 = inputIsQuote ? !baseIsToken0 : baseIsToken0` with
`baseIsToken0 = true`. The caller resolves, from that one boolean, the
input/output token accounts (owner ATAs), vaults (`tokenVault0/1`), and
mints (`tokenMint0/1`); it passes `ammConfig`, `observationKey`,
`tickSpacing` from the cached startup state and the fresh
`tickCurrentIndex` from the snapshot.

### Orca leg (`buildWhirlpoolSwapIx`)

Identical to `index.ts`'s `buildWhirlpoolLeg`: buy SOL = `aToB = false`,
sell SOL = `aToB = true`; ATAs derived from base/quote mints, vaults and
`tickSpacing` from the whirlpool state, fresh `tickCurrentIndex` from the
snapshot.

### Amounts, profit guard, ordering

Identical to the existing builders. Buy leg's min-out = `opp.baseOut`
(guarantees the sell leg's input exists); sell leg's min-out =
`minQuoteOut` (enforces profitability **on-chain** — if state moved and
the numbers no longer clear the threshold, the whole tx reverts, and the
mandatory simulation catches it before any send). Leg order in the tx:
buy leg first, then sell leg (matches `index.ts`). `setComputeUnitLimit`
prepended only when `computeUnitLimit` is provided. Payer union
(`Keypair` → signed / `PublicKey` → unsigned shadow build) identical to
the existing builders.

## `ClmmOrcaPollingSource` — the polling source

New file `src/datasource/clmmOrcaPolling.ts`, analog of
`orcaOrcaPolling.ts`.

- **Config:** `{ clmmPoolAddress, whirlpoolAddress, pair, pollIntervalMs }`
  plus an injected `feeBps` for the CLMM leg (resolved once at startup —
  see fee caching). The Orca leg's fee comes from its own decoded state,
  as today.
- **Per cycle:** one `getMultipleAccountsInfoAndContext([clmmPool,
  whirlpool])` batch (one RPC, respects the rate limiter,
  `fetchStartedAtMs` stamped before the await — identical to
  `orcaOrcaPolling.ts`). Decode CLMM via `decodeClmmPool` →
  `toClmmSnapshot(state, cachedFeeBps, meta)`; decode Orca via
  `decodeWhirlpool` → the existing whirlpool snapshot. Emit
  `SnapshotPair{ cpmm: clmmSnap, whirlpool: orcaSnap }`.
- **Orientation guards (both load-bearing, both kept):** `toClmmSnapshot`
  already throws on a non-`base=mint0/quote=mint1` pool; the Orca
  snapshot keeps its existing A/B orientation check.
- **Failure handling:** mirror `orcaOrcaPolling.ts`'s `noteFailure`
  (429/rate-limit backoff vs generic cycle-failure warning).

### Fee caching (the one structural difference from two-Orca)

CLMM's trade fee lives in the referenced `AmmConfig`, **not** the pool
account, and is effectively static. So the polling source never reads it:
`setUpClmmOrca` resolves it once at startup (read CLMM pool →
`state.ammConfig` → read that account → `decodeClmmAmmConfigFeeBps`) and
injects the resulting `feeBps`. This mirrors how `PollingPriceSource`
fetches the Raydium `AmmConfig` once at startup, and keeps the per-cycle
cost at exactly one batch read of two accounts.

## `main.ts` wiring + `config.ts`

### `config.ts` (additive only)

- Extend the `venue` union to
  `"cpmm-orca" | "orca-orca" | "clmm-orca"` and its validation message.
- Add `raydiumClmmProgramId`, default mainnet
  `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, overridable via
  `RAYDIUM_CLMM_PROGRAM_ID` (same pattern as `raydiumProgramId` /
  `orcaProgramId`). This is a **distinct** program from the CPMM
  `raydiumProgramId` already in config.
- Add `clmmPoolAddress?` (env `RAYDIUM_CLMM_POOL_ADDRESS`). For the Orca
  leg, **reuse the existing `ORCA_POOL_ADDRESS`** — no new key.
- Per-venue required-keys map gains:
  `clmm-orca → ["RAYDIUM_CLMM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"]` plus
  the existing `BASE_MINT`/`QUOTE_MINT`/`BASE_DECIMALS`/`QUOTE_DECIMALS`.
- `.env.example` gains a documented `clmm-orca` block. Run defaults: CLMM
  pool = the live-verified `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`;
  Orca pool = whatever SOL/USDC whirlpool `ORCA_POOL_ADDRESS` already
  points at.

### `main.ts` (additive only)

- New `setUpClmmOrca(...)`, following `setUpOrcaOrca`'s structure exactly:
  startup reads (CLMM pool + its `ammConfig` for the cached fee, Orca pool
  for static state), construct `ClmmOrcaPollingSource`, build the
  `buildTx` closure over `buildClmmOrcaArbTransaction`, and
  `resolveStartupFeeLamports` with a `sampleOpportunity` whose
  `buyOn`/`sellOn` are `raydium-clmm`/`orca-whirlpool`.
- Polling-only, mirroring `setUpOrcaOrca`: `DATA_SOURCE=geyser` with
  `VENUE=clmm-orca` throws a clear "not wired" error (YAGNI — no
  heterogeneous Geyser source).
- Dispatch: add the `cfg.venue === "clmm-orca"` branch alongside the
  existing `orca-orca` branch.

## Mainnet sim smoke-check

New `scripts/smoke-clmm-orca-arb-sim.ts`, analog of
`smoke-two-whirlpool-sim.ts` (and the swap_v2 builder's smoke-check),
read-only end to end:

- Build **one atomic `buildClmmOrcaArbTransaction`** (both legs, shared
  ATAs) against the live CLMM pool `3ucNos4…` + the configured Orca
  SOL/USDC whirlpool, small fixed size (~100 USDC, consistent with the
  swap_v2 smoke-check).
- Surrogate owner `MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa` (already
  funded with USDC + WSOL — verified live in an earlier session), built
  **unsigned** (`payer: PublicKey`), simulated `sigVerify:false` — same
  ADR-0008 shadow pattern.
- Simulate **both direction assignments** (buy-on-CLMM/sell-on-Orca and
  the reverse) so account order + PDA derivation are exercised for each
  leg orientation.
- **Assert:** `err:null` on **both** direction assignments (the relaxed
  threshold removes profitability as the gate, so a failure means a
  malformed tx, not an unfavorable gap); both the Raydium CLMM and Orca
  Whirlpool program IDs appear in the sim logs (proves both legs executed
  atomically, not just one); CU consumption is sane (order of ~90–100k,
  i.e. roughly the ~44k CLMM + ~56k two-Orca-leg figures combined); and
  confirm by code review that the script has no
  `sendRawTransaction`/`sendTransaction` path.

**Profitability caveat (honest pass criterion):** an unprofitable
real-time price gap makes the sell leg's min-out fail with a concrete
slippage error — expected, and distinct from a malformed-tx failure. The
smoke-check's pass criterion is a *well-formed* tx reaching both programs,
which is assertable even when the market gap doesn't clear: relax the
sell-leg threshold to `0`/`1` for the shape check, exactly as a
fee-sample opportunity does.

## Testing

### Unit tests — `tests/clmmOrca.test.ts` (pure, no network)

Mirror `twoWhirlpool`/`index` test style:

1. **Direction — buy on CLMM / sell on Orca:** CLMM leg
   `inputIsToken0 = false`, Orca leg `aToB = true`. Assert both legs'
   resolved input/output ATAs, vaults, mints, and the amount/min-out
   assignment (`buy.minOut = baseOut`, `sell.minOut = quoteIn +
   minProfit`).
2. **Direction — reverse (buy on Orca / sell on CLMM):** Orca
   `aToB = false`, CLMM `inputIsToken0 = true`; same assertion set
   flipped.
3. **Leg order** in the compiled instruction list: buy leg precedes sell
   leg; `setComputeUnitLimit` prepended only when `computeUnitLimit` is
   provided.
4. **Shared ATAs:** both legs reference the same owner SOL ATA and the
   same USDC ATA (one derivation each, not four).
5. **Unsigned vs signed:** `PublicKey` payer → unsigned tx; `Keypair`
   payer → signed (mirrors the existing builders).

### Polling-source test — `tests/clmmOrcaPolling.test.ts`

Fake `AccountBatchFetcher` (same technique as the `orcaOrcaPolling`
tests): one cycle emits a `SnapshotPair` with CLMM in the `cpmm` slot
carrying the injected `feeBps` and Orca in the `whirlpool` slot; a missing
account throws; an orientation mismatch throws.

### Regression

Full suite + typecheck stay green; no existing test changes.

## Isolation, error handling

**Isolation boundary (different by nature from the prior two specs):**
this is the *wiring* spec, so it necessarily edits `config.ts` and
`main.ts` — the exact edits the decoder and swap_v2 specs explicitly
deferred here. Everything else is new files. The edits are strictly
**additive**: a new `venue` union member + new optional config keys + a
new `setUpClmmOrca` branch; the `cpmm-orca`, `orca-orca`, and synthetic
paths are untouched, so a future two-Orca restart still works. Implement
in an isolated **worktree** (as both prior specs did): the live
`shadow-run-2` process already has `main.ts` loaded in memory, so on-disk
edits can't disturb it, but the worktree keeps the working tree clean
until merge.

**Do-not-touch list:** `detect.ts`, `costs.ts`, `fee.ts`, `executor.ts`,
`logger.ts`, `orcaOrcaPolling.ts`, `polling.ts`, `math/whirlpool.ts`,
`txbuilder/index.ts`, `txbuilder/twoWhirlpool.ts`,
`txbuilder/orcaWhirlpool.ts`, `txbuilder/raydiumClmm.ts`,
`decode/clmm.ts`.

**Error handling:** no new throwing surface beyond what the leg builders
and orientation guards already provide; malformed inputs trust callers,
consistent with the existing builders. A sim failure in the smoke-check
is a loud, expected dev-time signal, not a runtime path to design around.

## Forward-looking notes (documented, NOT built here)

- **ADR-0010 "Raydium CLMM as cross-DEX shadow venue"** — captured when
  the venue actually runs and produces its first signal (the run is out
  of this spec's scope).
- The `handoffMs`/latency metric open finding (session log,
  `main.ts:147`) is **orthogonal** and out of scope — the cross-DEX
  go/no-go signal is about opportunity count / net gap, which this venue
  produces regardless of the latency metric's trustworthiness.
- **Deferred dedup candidate:** unify the three near-identical arb-tx
  builders (`index.ts`, `twoWhirlpool.ts`, `clmmOrca.ts`) behind a leg
  abstraction once the venue is proven — deliberately not done now to
  protect the live paths.
- Tick-array heuristic inherits the swap_v2 builder's documented
  limitation (fixed 3 arrays, fine for ~100 USDC on a $5.9M pool); a
  larger size or sparse liquidity is a candidate follow-up.

## Success criteria

- `buildClmmOrcaArbTransaction` produces a well-formed atomic
  `VersionedTransaction`: correct CLMM + Orca legs (input/output
  resolution, vaults, mints, min-out/profit guard) for both direction
  assignments, shared owner ATAs, correct leg order, signed/unsigned per
  payer type.
- `ClmmOrcaPollingSource` emits a correct `SnapshotPair` (CLMM in `cpmm`
  slot with the cached `feeBps`, Orca in `whirlpool` slot) from one batch
  read per cycle; orientation/missing-account guards throw.
- `VENUE=clmm-orca` wires end to end through `setUpClmmOrca` with additive
  config only; `cpmm-orca`/`orca-orca`/synthetic paths unaffected.
- The mainnet sim smoke-check simulates the atomic two-leg tx with
  `err:null` on both direction assignments (relaxed sell-leg threshold),
  both program IDs in the logs, sane CU, and zero send capability in the
  script.
- All new unit tests pass; existing tests + typecheck remain green.
- Isolation boundary holds: only new files + the additive `config.ts` /
  `main.ts` / `.env.example` edits.
