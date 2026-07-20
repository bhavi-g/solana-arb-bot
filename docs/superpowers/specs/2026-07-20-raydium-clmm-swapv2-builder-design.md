# Raydium CLMM swap_v2 instruction builder — design

**Status:** approved (design), pre-implementation
**Date:** 2026-07-20
**Context:** Phase 2 / Option 1 follow-up — cross-DEX Raydium-CLMM-vs-Orca
venue. The decoder foundation (`src/decode/clmm.ts`, merged `ade7628`)
gave us the read side; this spec is the hard write-side primitive: a
Raydium CLMM `swap_v2` instruction builder, proven against the live
program. The atomic arb tx, polling source, and `VENUE` wiring are a
documented follow-up spec.

## Problem

The two-Orca interim venue's 72h shadow run produced zero signal (0
opportunities across 28,469 cycles — documented negative finding,
`docs/phases/phase-2-mainnet-shadow-mode.md`), as expected: two deep
same-pair Orca pools stay aligned. The real Phase-3 go/no-go signal needs
the cross-DEX Raydium-CLMM-vs-Orca venue (Option 1). The decoder
foundation exposes everything a swap instruction needs
(`ClmmPoolState`: `ammConfig`, `tokenVault0/1`, `observationKey`,
`tickSpacing`, price/tick state), live-verified on pool
`3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv` ($5.9M TVL, 4bps,
orientation NORMAL — SOL is mint_0). What's missing is the ability to
actually construct a CLMM swap transaction.

## Scope

**In scope (this spec — "swapV2 builder foundation"):**

- `src/txbuilder/raydiumClmm.ts` — `buildClmmSwapV2Ix(params)` plus
  tick-array and bitmap-extension PDA helpers.
- `tests/raydiumClmm.test.ts` — unit tests: encoding, PDA derivation,
  account order/direction handling.
- `scripts/smoke-clmm-swap-sim.ts` — read-only mainnet simulation proving
  one `swap_v2` leg executes against the live program.

**Out of scope (follow-up spec), documented here as forward notes:**

- `buildClmmOrcaArbTransaction` — the atomic two-leg arb tx (CLMM leg +
  Orca leg, shared ATAs).
- A `clmm-orca` polling source.
- `VENUE="clmm-orca"` config + `setUpClmmOrca` wiring in `main.ts`.

## Isolation boundary

Same discipline as the decoder foundation: this spec touches **only new
files**. No edits to `src/datasource/orcaOrcaPolling.ts`,
`src/datasource/polling.ts`, `src/math/whirlpool.ts`, `src/detect.ts`,
`src/txbuilder/orcaWhirlpool.ts`, `src/txbuilder/twoWhirlpool.ts`,
`src/txbuilder/index.ts`, or `src/decode/clmm.ts`. The currently-running
two-Orca shadow (and its post-window-close restart on the corrected
`handoffMs` metric) is unaffected. The smoke-check script is read-only
(`simulateTransaction` only, `sigVerify:false`, surrogate owner,
identical safety pattern to `scripts/smoke-two-whirlpool-sim.ts`) — it
cannot send anything.

## Decisions (owner-approved)

### Instruction: `swap_v2` (not legacy `swap` v1)

Raydium CLMM exposes both. For SOL/USDC (classic SPL Token, not
token-2022) the legacy `swap` would work with fewer accounts, but
`swap_v2` is what real arbers and routers submit today, and is
token-2022-forward-compatible. Chosen for shadow-data fidelity: the whole
point of this venue is a faithful go/no-go signal, so the instruction
shape, account list, and CU cost should match what a live competitor
actually sends.

### Tick-array selection: fixed 3-array heuristic (not bitmap discovery)

Mirrors the existing Orca whirlpool builder
(`src/txbuilder/orcaWhirlpool.ts`): take the array containing the current
tick and the next two in the swap direction, rather than decoding
`tick_array_bitmap` (+ extension) to find exact initialized arrays.
Sufficient because the shadow trades a fixed, modest size (100 USDC on a
$5.9M pool) that stays within 1–2 arrays in practice. The
`tick_array_bitmap_extension` PDA is still derived and included as a
required account regardless — we just don't walk its contents for array
selection. A large trade size or sparse liquidity could need more arrays
than the heuristic provides; this is a documented limitation consistent
with the project's existing Phase-1 discipline (spot price + slippage
haircut, not full tick-crossing simulation — `src/math/whirlpool.ts`
header comment) and is a candidate follow-up if trade sizing changes.

## `buildClmmSwapV2Ix` — the instruction

### Discriminator + data (41 bytes)

Anchor pattern, same as `orcaWhirlpool.ts`'s `global:swap`:
`WHIRLPOOL_SWAP_DISCRIMINATOR = sha256("global:swap")[0..8]`. Here:

```
CLMM_SWAP_V2_DISCRIMINATOR = sha256("global:swap_v2")[0..8]   // 8 bytes
amount: u64                                                    // 8 bytes
other_amount_threshold: u64                                    // 8 bytes
sqrt_price_limit_x64: u128                                     // 16 bytes
is_base_input: bool                                            // 1 byte
```

`amount_specified_is_input` semantics are folded into `is_base_input` per
the CLMM v2 instruction signature (verified against source at
implementation, same as the decoder offsets — see Verification below).

### Accounts

Exact order, writable/signer flags **verified against raydium-clmm
source at implementation time** (pinned commit recorded in the file
header, same discipline as `decode/clmm.ts`'s
`verified against ... @ <commit>` pattern):

1. `payer` (signer)
2. `amm_config`
3. `pool_state` (writable)
4. `input_token_account` (writable)
5. `output_token_account` (writable)
6. `input_vault` (writable)
7. `output_vault` (writable)
8. `observation_state` (writable)
9. `token_program`
10. `token_program_2022`
11. `memo_program`
12. `input_vault_mint`
13. `output_vault_mint`

Remaining accounts:

14. `tick_array_bitmap_extension`
15–17. up to 3 tick arrays (writable), in swap direction

### Direction: one boolean drives everything

`inputIsToken0: boolean` (mirrors the Orca builder's `aToB`) determines,
in one place:

- which mint/vault/token-account is input vs. output,
- the tick-array walk direction (token0→token1 = price falls = walk to
  lower tick-array start indices; token1→token0 = walk higher),
- the `sqrt_price_limit_x64` bound: `MIN_SQRT_PRICE_X64` for
  token0→token1, `MAX_SQRT_PRICE_X64` for token1→token0 (CLMM-specific
  constants, verified against source — near but not bit-identical to
  Orca's `MIN_SQRT_PRICE`/`MAX_SQRT_PRICE`, since CLMM's tick/price bounds
  are defined independently in its own program).

Given the live pool's confirmed orientation (SOL = mint_0, USDC =
mint_1), a SOL→USDC sell is `inputIsToken0 = true`; a USDC→SOL buy is
`inputIsToken0 = false`.

## Tick-array + bitmap PDA helpers

The key structural differences from Orca, all isolated in this new file
(no changes to `orcaWhirlpool.ts`):

- `CLMM_TICK_ARRAY_SIZE = 60` (Orca's `TICK_ARRAY_SIZE = 88`).
- `clmmTickArrayStartIndex(tick, tickSpacing)`:
  `floor(tick / (tickSpacing * 60)) * (tickSpacing * 60)` — floor
  division so it's correct for negative ticks (the live pool's current
  tick is −25696).
- `clmmTickArrayPda(programId, pool, startIndex)`: seed
  `["tick_array", pool, <startIndex as i32, 4 bytes, BIG-ENDIAN>]`. **This
  is the critical divergence from Orca**, whose seed is the start index
  as an ASCII decimal string (`Buffer.from(String(startIndex))`). Getting
  the byte representation and endianness wrong here silently derives the
  wrong PDA — this is exactly the kind of thing the live sim smoke-check
  is designed to catch (a wrong tick-array PDA fails simulation with a
  concrete on-chain error, not a silent bug).
- `tickArrayBitmapExtensionPda(programId, pool)`: seed
  `["pool_tick_array_bitmap_extension", pool]` — always derived and
  always included as account #14, independent of the array-selection
  heuristic.
- CLMM-specific `CLMM_MIN_SQRT_PRICE_X64` / `CLMM_MAX_SQRT_PRICE_X64`
  constants, verified against source.

## Testing

### Unit tests (pure, no network) — `tests/raydiumClmm.test.ts`

1. Discriminator bytes match `sha256("global:swap_v2")[0..8]`.
2. Instruction data layout: amount/threshold/sqrt-price-limit/
   is_base_input land at the documented byte offsets (mirrors
   `tests/orcaWhirlpool.test.ts`'s pattern, if one exists, or
   `tests/txbuilder.test.ts`'s style otherwise).
3. `clmmTickArrayStartIndex` on a negative tick (e.g. −25696, matching
   the live pool) floors correctly (not truncates toward zero).
4. `clmmTickArrayPda` determinism, including a negative start index —
   proves the i32 big-endian seed encoding is exercised, not just the
   positive-index happy path.
5. Full account list: correct count (13 fixed + bitmap-extension + up to
   3 tick arrays), correct order, correct writable/signer flags.
6. Direction flip: `inputIsToken0 = true` vs `false` swaps input/output
   vaults and mints, flips the tick-array walk direction, and flips the
   `sqrt_price_limit_x64` bound — one assertion set per side, proving the
   single boolean genuinely drives all three concerns.

### Mainnet sim smoke-check (read-only) — `scripts/smoke-clmm-swap-sim.ts`

Live-verification leg, the analog of the decoder's mainnet probe. Pattern
matches `scripts/smoke-two-whirlpool-sim.ts`:

- Target: live pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`.
- Surrogate owner `MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa` (same
  surrogate used by the existing two-Orca smoke check; already funded
  with USDC + WSOL — verified live in an earlier session).
- Build ONE `swap_v2` leg: small USDC amount → SOL (`inputIsToken0 =
  false`).
- Simulate as the surrogate with `sigVerify:false` (unsigned build,
  `payer: PublicKey` not `Keypair` — same `ArbBuildContext`-style pattern
  already used for shadow-mode simulation, ADR-0008 ✕ T31).
- Assert: `err:null`, the Raydium CLMM program ID appears in the
  simulation logs, CU consumption is sane (order of magnitude comparable
  to the ~56k CU the two-Orca smoke check measured), and confirm via code
  review that nothing in the script can call `sendRawTransaction` or
  `sendTransaction` — simulate-only, zero send capability present.

This is the step that actually proves account order, PDA derivation, and
encoding against the real program — a wrong tick-array PDA, wrong
discriminator, or misordered account produces a concrete, legible
simulation error rather than a silent bug.

## Verification discipline

Same dual-source requirement as the decoder foundation: the account list,
account order, writable/signer flags, and instruction data layout are
transcribed from raydium-clmm source
(`programs/amm/src/instructions/swap_v2.rs`, or equivalent) at a pinned
commit recorded in the file header — AND confirmed live via the mainnet
sim smoke-check succeeding with `err:null`. Do not consider the builder
done on source-only or sim-only verification.

## Error handling

- No new error-throwing surface beyond standard `TransactionInstruction`
  construction; malformed inputs (e.g. `amount < 0n`) can mirror the
  `orcaWhirlpool.ts`/`whirlpool.ts` pattern of explicit `RangeError`
  guards if a corresponding check exists there — otherwise trust callers,
  consistent with the existing builders (`buildWhirlpoolSwapIx` does not
  itself validate `amount`).
- The smoke-check script is read-only end-to-end; a simulation failure
  (`err != null`) is a loud, expected failure mode during development,
  not a runtime error path to design around.

## Forward-looking notes (documented, NOT built in this spec)

For the follow-up spec (the full runnable `clmm-orca` venue):

- **`buildClmmOrcaArbTransaction`**: one atomic tx, CLMM leg + Orca leg,
  sharing the owner's SOL/USDC ATAs — direct structural analog of
  `src/txbuilder/twoWhirlpool.ts`. Buy/sell pool disambiguation follows
  the existing `ArbDirection.buyPoolAddress`/`sellPoolAddress` pattern
  (already generalized for exactly this multi-venue-of-same-DEX-name
  case in the two-Orca work).
- **`clmm-orca` polling source**: CLMM pool account + Orca whirlpool
  account per cycle (`getMultipleAccountsInfoAndContext`, one batch
  read); `ammConfig` is effectively static and should be fetched once at
  startup and cached, not re-read every cycle (mirrors how
  `PollingPriceSource` fetches the Raydium `AmmConfig` once at startup
  today).
- **`VENUE="clmm-orca"`** config value + `setUpClmmOrca` in `main.ts`,
  following the exact `setUpOrcaOrca` structure (source + buildTx +
  feeLamportsWithHeadroom).
- Capture a small **ADR-0010** ("Raydium CLMM as cross-DEX shadow venue")
  when the full venue lands and is running.

## Success criteria

- `buildClmmSwapV2Ix` produces a well-formed `TransactionInstruction`:
  correct discriminator, correct data layout, correct account list
  (order, writable/signer flags) for both swap directions.
- Tick-array and bitmap-extension PDAs are correct, verified by the live
  simulation succeeding (a wrong PDA fails simulation loudly).
- The mainnet sim smoke-check simulates `err:null` for a real `swap_v2`
  leg against the live pool, with zero send capability in the script.
- All new unit tests pass; existing tests and typecheck remain green.
- No edits to any existing venue's source/detection/tx-builder files —
  isolation boundary holds, same as the decoder foundation.
