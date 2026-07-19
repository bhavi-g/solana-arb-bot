# Raydium CLMM decoder + math foundation — design

**Status:** approved (design), pre-implementation
**Date:** 2026-07-17
**Context:** Phase 2 / Option 1 — cross-DEX Raydium-vs-Orca venue. This spec
is the read-side foundation only; the tx-builder and venue wiring are a
documented follow-up spec.

## Problem

The mainnet Raydium CPMM SOL/USDC pool is unviable at ~$429 TVL, so real
Raydium SOL/USDC depth lives on Raydium CLMM (concentrated liquidity),
which we do not decode. Option 1 (owner-approved next venue) is to build a
Raydium CLMM decoder so we can run a true cross-DEX Raydium-vs-Orca shadow
— the real Phase-3 go/no-go signal. The currently-running two-Orca 72h
shadow is interim data only.

Raydium CLMM is a Uniswap-V3-family concentrated-liquidity AMM, the same
family as Orca Whirlpool: both store a **Q64.64 sqrt price** and tick
state. This makes our existing whirlpool spot-price math reusable and
localizes the new work to decoding + (later) the swap instruction.

## Scope

**In scope (this spec):**

- `src/decode/clmm.ts` — `decodeClmmPool` (pool account) and
  `decodeClmmAmmConfigFeeBps` (separate AmmConfig account).
- Reuse of `src/math/whirlpool.ts` **unchanged** for CLMM detection.
- A pure CLMM→snapshot adapter emitting a `WhirlpoolSnapshot` with
  `dex: "raydium-clmm"`.
- `tests/clmm.test.ts` — decode + fee + adapter + detection round-trip,
  against fixtures captured from a live mainnet pool.
- `scripts/probe-mainnet-clmm-pools.ts` — read-only pool discovery and
  fixture capture.

**Out of scope (follow-up spec), documented here as forward notes:**

- The Raydium CLMM swap (`swapV2`) tx-builder leg.
- A `clmm-orca` polling source.
- `VENUE` config wiring / main.ts integration.

## Chosen approach — snapshot typing (Approach A)

A CLMM snapshot is structurally identical to a `WhirlpoolSnapshot`
(`sqrtPriceX64`, `liquidity`, `tickCurrentIndex`, `feeBps`), and
`src/detect.ts` already prices any concentrated-liquidity pool at spot
price with a Phase-1 slippage haircut. So:

- Add `"raydium-clmm"` to the `Dex` union (additive; verified below to be
  non-breaking).
- CLMM pools emit `kind: "whirlpool"` (the concentrated-liquidity math
  kind) with `dex: "raydium-clmm"`.
- **Zero changes to `detect.ts`** — CLMM flows through the existing
  concentrated-liquidity branch automatically. `dex` carries venue
  identity for logging and the future tx-builder.

The only semantic cost — `kind: "whirlpool"` on a Raydium pool — is
neutralized by a doc comment on `WhirlpoolSnapshot` reframing the kind as
"concentrated-liquidity (Orca Whirlpool or Raydium CLMM)". The smell is
documented, not hidden.

Rejected alternatives: (B) rename the `kind` to `"clmm"` across
types.ts/detect.ts/orcaOrcaPolling.ts/tests — cleaner naming but churns a
file in the running shadow's code path for no behavior gain; (C) a
separate `kind: "clmm"` union member with its own identical detect branch
— duplicates the single price-impact computation location (ADR-0006).

### Non-breaking check (done at design time)

The only `Dex` consumer that branches on a value is a single boolean
`opp.direction.buyOn === "raydium-cpmm"` in `src/txbuilder/index.ts`.
There is no exhaustive `switch`/`never` on `Dex` anywhere in `src/`.
Adding a union member is therefore purely additive.

## Isolation boundary (hard constraint)

The running 72h shadow's code path is
`orcaOrcaPolling.ts → detect.ts → math/whirlpool.ts`. This spec touches
none of them behaviorally:

- **No edits** to `src/datasource/orcaOrcaPolling.ts`.
- **No edits** to `src/math/whirlpool.ts` — reused as-is, not even a
  comment change, to keep the running path pristine.
- **No logic edits** to `src/detect.ts`.
- The only shared-file edits are two **additive, behavior-preserving**
  changes to `src/types.ts`: (a) `"raydium-clmm"` added to `Dex`, (b) a
  doc comment on `WhirlpoolSnapshot`.

Everything else is new files. The probe script is read-only. The running
process is already loaded; on-disk source edits cannot affect it.

## Components

| Unit | File | Purpose | Depends on |
|---|---|---|---|
| CLMM pool decoder | `src/decode/clmm.ts` | `decodeClmmPool(bytes) → ClmmPoolState` | `layout.ts` |
| CLMM fee decoder | `src/decode/clmm.ts` | `decodeClmmAmmConfigFeeBps(bytes) → number` | `layout.ts` |
| Snapshot adapter | `src/decode/clmm.ts` | `toClmmSnapshot(state, feeBps, meta) → WhirlpoolSnapshot` | `types.ts` |
| Tests | `tests/clmm.test.ts` | decode + fee + adapter + detection round-trip | above + `detect.ts` (read-only import) |
| Probe/capture | `scripts/probe-mainnet-clmm-pools.ts` | read-only discovery + fixture dump | RPC |

## `decode/clmm.ts` — account layout

Source of truth: `raydium-io/raydium-clmm`,
`programs/amm/src/states/pool.rs` and `config.rs`. Anchor account =
8-byte discriminator + borsh fields.

### Offset verification requirement (both sources, mandatory)

Byte offsets in `decode/clmm.ts` MUST be verified against **BOTH**:

1. the **pinned raydium-clmm source commit** (recorded in the file
   header, e.g. `verified 2026-07-1x against raydium-io/raydium-clmm
   programs/amm/src/states/{pool,config}.rs @ <commit>`), AND
2. **live captured mainnet pool + AmmConfig account data** (the probe
   fixtures below), decoded and sanity-asserted.

Do **not** proceed on source-only or live-only verification. This matches
the header-comment discipline already used in `decode/orcaWhirlpool.ts`
and `decode/raydiumCpmm.ts`.

### `ClmmPoolState` — fields extracted

- `ammConfig: PublicKey` — points to the fee account (fee is NOT in the
  pool account, unlike Whirlpool).
- `tokenMint0`, `tokenMint1: PublicKey` — orientation (see below).
- `tokenVault0`, `tokenVault1`, `observationKey: PublicKey` — decoded now
  for the future tx-builder; not used by detection.
- `mintDecimals0`, `mintDecimals1: number`; `tickSpacing: number`.
- `liquidity: bigint (u128)`, `sqrtPriceX64: bigint (u128)`,
  `tickCurrentIndex: number (i32)` — the detection-critical trio.
- `status: number` — pool enable/disable bitfield; decoded so a disabled
  pool can later be refused, and recorded for the log.

Length guard throws `"ClmmPoolState too short: <len> < <min>"` mirroring
the existing decoders.

### Fee — separate account, its own decoder (reuse trap)

CLMM `AmmConfig` has a **different layout from CPMM's** `AmmConfig`: CLMM
`trade_fee_rate` is a `u32` (parts-per-million); CPMM's is a `u64` at
offset 12. Therefore `decodeAmmConfigFeeBps` from `raydiumCpmm.ts` is
**not** reusable. CLMM gets its own `decodeClmmAmmConfigFeeBps` returning
`trade_fee_rate_ppm / 100` → basis points (the 10,000-bps convention used
system-wide). The file header will explicitly warn against "consolidating"
the two AmmConfig decoders.

## Math reuse

`src/math/whirlpool.ts` is already venue-agnostic:
`whirlpoolBaseToQuote` / `whirlpoolQuoteToBase` take only
`(amount, sqrtPriceX64, feeBps)`. Raydium CLMM stores the same Q64.64
sqrt price with the same semantics (`sqrt(price)`, price = mint_1 per
mint_0). So CLMM detection reuses this module **unchanged**, flowing
through detect.ts's existing spot-price + Phase-1 slippage-haircut path.

### Orientation — verification checkpoint (report to owner)

The reused math is correct only if **base = mint_0 and quote = mint_1**
(SOL = token_0, USDC = token_1). Raydium orders mints canonically by
pubkey bytes, so the selected mainnet pool may have SOL as mint_1
(inverted).

- The adapter **asserts** `tokenMint0 == pair.baseMint &&
  tokenMint1 == pair.quoteMint` and throws on mismatch (same guard style
  as `orcaOrcaPolling.ts`).
- When the probe selects the actual pool, the implementer MUST **report
  to the owner explicitly** whether the pool is inverted (SOL as mint_1)
  or not — either way, stated, not silently handled.
- If inverted, supporting it (sqrt-price inversion vs base/quote
  remapping) is a scoped follow-up decision, NOT a silent transformation
  in this spec.

## Snapshot adapter & detection wiring

`toClmmSnapshot(state, feeBps, { poolAddress, pair, slot, source,
fetchedAtMs }) → WhirlpoolSnapshot`:

- `kind: "whirlpool"`, `dex: "raydium-clmm"`.
- carries `sqrtPriceX64`, `liquidity`, `tickCurrentIndex`, `feeBps`.
- asserts orientation (above).

Because Approach A needs no detect.ts change, a CLMM snapshot *is* a
`WhirlpoolSnapshot`, so `detect(clmmSnap, orcaSnap, params)` just works.
Proven by test; not wired into `main.ts` (that is the follow-up).

## Error handling

- Length guards on both decoders (throw, mirroring existing decoders).
- Orientation assertion in the adapter (throw).
- All decode/adapter units are pure and deterministic — no I/O.

## Testing (`tests/clmm.test.ts`, TDD)

Mirrors `tests/decode.test.ts` / `tests/whirlpool.test.ts`; fixtures are
captured mainnet account bytes (base64).

1. `decodeClmmPool` on captured pool bytes → asserts mints (SOL/USDC),
   decimals (9/6), `tickSpacing`, and
   `sqrtPriceX64ToPrice(...)` ≈ live SOL/USDC price (sanity band).
2. `decodeClmmAmmConfigFeeBps` on captured config bytes → asserts the
   pool's advertised fee tier.
3. `toClmmSnapshot` → correct `dex`/`kind`/fields; throws on a
   flipped-mint fixture.
4. Detection round-trip: CLMM snapshot vs a synthetic Orca snapshot →
   `detect()` flags an opportunity when prices diverge past threshold,
   none when aligned.

## Verification against a live pool

`scripts/probe-mainnet-clmm-pools.ts` — read-only, paginated, patterned on
`scripts/probe-mainnet-pools.ts`:

- enumerate Raydium CLMM SOL/USDC pools, rank by TVL/depth, print the
  deepest,
- dump its **pool + amm_config** account bytes (base64) as test fixtures.

This step (a) confirms offsets against real data, (b) resolves the
orientation question for the owner report, (c) captures fixtures.
Read-only — cannot disturb the running shadow.

## Forward-looking tx-builder notes (documented, NOT built)

For the follow-up spec, the CLMM leg differs from the Orca leg in four
ways:

- **Instruction:** `swapV2` (discriminator =
  `sha256("global:swap_v2")[..8]`), not Orca's `global:swap`. Data =
  `amount, other_amount_threshold, sqrt_price_limit_x64 (u128),
  is_base_input (bool)`.
- **Tick arrays:** array size **60** (not Whirlpool's 88); the tick-array
  PDA seed uses the start index as **i32 big-endian bytes** (not
  Whirlpool's ASCII decimal string). So `orcaWhirlpool.ts`'s
  `tickArrayPda` / `tickArrayStartIndex` are **not** reusable as-is; CLMM
  needs new helpers.
- **Extra accounts:** a `tick_array_bitmap_extension` PDA, a writable
  `observation_state`, and token-2022 program/mint accounts for `swapV2`.
- **Data source:** the future `clmm-orca` polling source fetches **2
  accounts** (pool + amm_config); amm_config is effectively static and can
  be cached, so steady state stays one hot account read.

Also: capture a small **ADR-0010 ("Raydium CLMM as cross-DEX shadow
venue")** when the follow-up lands.

## Success criteria

- `decode/clmm.ts` decodes a live mainnet Raydium CLMM SOL/USDC pool and
  its AmmConfig, offsets verified against both source and live data.
- The decoded `sqrtPriceX64` run through unchanged `whirlpool.ts` math
  produces a sane SOL/USDC price.
- `toClmmSnapshot` output drives `detect()` with zero detect.ts changes.
- All new tests pass; existing tests and typecheck remain green.
- Owner has been told explicitly whether the chosen pool is inverted.
- No edits to `orcaOrcaPolling.ts` or `math/whirlpool.ts`.
