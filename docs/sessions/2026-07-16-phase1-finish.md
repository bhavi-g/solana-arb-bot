# Session log — 2026-07-16 (attended, Phase 1 finish)

Continues from `2026-07-16.md` (overnight run) and the transfer handoff
(`docs/HANDOFF.md`). Owner is attending this session. Reordered plan:
(1) fee-default ADR + fix, (2) pool seeding, (3) live polling → real send.
Superpowers skills active this session (brainstorming, TDD, verification-
before-completion). All times UTC.

## Task 1 — EST_TX_FEE_QUOTE: real fetched fee instead of hardcoded 1000

**Status: DONE.** ADR-0007 written, reviewed by owner, accepted, implemented,
full suite green.

### What I built
- **ADR-0007** (`docs/adr/0007-real-fetched-tx-fee-estimate.md`, status
  `accepted` — owner reviewed before acceptance, unlike 0001–0006). Decision:
  fetch the real base fee once at startup via `getFeeForMessage` on the
  actual arb-tx shape (fallback: 5000 lamports/sig protocol constant);
  apply a fixed **+20% headroom to the lamport figure only**; convert to
  quote units at the live mid price **every cycle**. `EST_TX_FEE_QUOTE`
  stays as an explicit manual override that bypasses the live path.
- Brainstormed SOL-vs-quote denomination first (superpowers:brainstorming).
  Outcome: keep the comparison in quote units (threshold + trade size are
  already quote-denominated), convert the fee into quote units — don't move
  the threshold into lamports.
- **`src/fee.ts`** (new) — pure helpers: `applyFeeHeadroom` (+20%, integer
  floor), `lamportsFeeToQuote` (reuses detect's exported mid-price helpers),
  `resolveBaseFeeLamports` (injected fetcher, falls back on null/throw/
  non-positive). `BASE_FEE_LAMPORTS_PER_SIGNATURE = 5000n`.
- **`src/detect.ts`** — exported `midPriceNum`/`midPriceDen` (were private)
  so the fee converter uses the SAME price math. `detect()` and its
  `DetectParams` interface are otherwise untouched.
- **`src/config.ts`** — `estTxFeeQuote` is now optional (`?: bigint`); the
  hardcoded `?? "1000"` default is gone. Only carried through when the env
  var is explicitly set (override).
- **`src/main.ts`** — startup `resolveStartupFeeLamports` builds the real
  arb tx and calls `getFeeForMessage`; per-cycle the fee is repriced via
  `lamportsFeeToQuote(feeLamportsWithHeadroom, pair.cpmm)` unless the
  override is set. Headroom is applied at startup, on lamports, before any
  conversion — never merged with the threshold (which detect.ts still
  compares as a separate step).
- **`.env.example`** — documents that `EST_TX_FEE_QUOTE` is an override,
  not a tuning knob layered on the computed default.

### Headroom / threshold separation (owner-requested clarification)
The +20% is applied in `applyFeeHeadroom(feeLamports)` — on the fetched
lamport fee, at startup, before unit conversion. It lives entirely inside
the fee number. `detect.ts` subtracts the converted fee to get
`estNetProfit`, THEN compares `estNetProfit >= minProfitThresholdQuote` as
a separate step (`src/detect.ts:97`, `:55`). The headroom never enters that
comparison and is never added to `MIN_PROFIT_THRESHOLD_QUOTE`. This is
stated in ADR-0007 Decision §2 and Consequences, and asserted structurally
by the fee unit tests.

### What works / was tested (evidence)
- **78 unit tests pass** (`npm test`) — the prior 68 plus 10 new in
  `tests/fee.test.ts` (headroom math incl. floor, lamports→quote at cpmm and
  whirlpool prices, rpc-value / null / throw / non-positive fallback paths,
  signature-count scaling). `npm run typecheck` clean.
- **detect.ts's 9 existing tests unaffected** — confirmed in the same run.
- **Live devnet smoke run** (synthetic data source, so the mandatory
  simulation still aborts on non-existent pools — nothing fabricated):
  ```
  [main] base tx fee 5000 lamports (rpc); +20% headroom -> 6000 lamports (ADR-0007)
  ...
  slot=3 gap=-300bps opportunity -> aborted-simulation-failed :: InstructionError [0, Custom 3012]
  ```
  The `(rpc)` tag confirms `getFeeForMessage` succeeded live (not the
  fallback): 1 signature = 5000 lamports, headroom → 6000. The fee is now
  derived from real devnet data, not the old hardcoded 1000.

## Task 2 — Pool seeding

### 2a. Raydium CPMM SDK decision (owner-gated) — DECIDED
Presented owner a 3-option comparison (same gate as the earlier Orca SDK
choice): (A) `@raydium-io/raydium-sdk-v2`, (B) legacy `@raydium-io/raydium-sdk`
v1, (C) hand-roll. **Owner chose A.** Installed
`@raydium-io/raydium-sdk-v2@0.2.59-alpha` as an **exact-pinned devDependency**
(no `^`, per repo convention). Verified: existing pins untouched
(`@solana/web3.js` 1.98.4, `@solana/spl-token` 0.4.15 — the SDK's
`^1.95.3`/`^0.4.8` ranges dedupe against them, no second web3 stack like the
Orca v2 trap); 78 tests still green.
- Rejected B: v1 targets the legacy AMM v4, not the CPMM program our bot
  uses; also conflicts on spl-token 0.3.9.
- Rejected C: CPMM `initialize` is far heavier than the swap we hand-encoded;
  high error surface on a real-funds script.
- Devnet specifics confirmed from the SDK itself:
  `DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM = DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`
  (matches our `src/config.ts` devnet CPMM ID),
  `CREATE_CPMM_POOL_FEE_ACC = 3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy`,
  plus `getCpmmPdaAmmConfigId`. NOTE: `raydium.api.*` config/pool fetchers are
  MAINNET-ONLY — devnet must use RPC-based reads (`getRpcPoolInfos`) and the
  devnet AmmConfig PDA. BN.js↔bigint conversion will be quarantined to
  `scripts/`; `src/` hot path stays SDK-free (still our own decoders/txbuilder).
- Orca side needs no new dep: `@orca-so/whirlpools-sdk` (0.21.0) already a devDep.

### 2b. Seeding script — IN PROGRESS (TDD, spends real devnet funds)
Next: build the seeding script test-first (superpowers:test-driven-development).

## WHAT'S LEFT (this session)
3. Live polling against seeded pools → an ACTUAL on-chain send (final
   Phase-1 exit criterion); verify with the real signature via
   superpowers:verification-before-completion.

## OPEN QUESTIONS / BLOCKERS
- None for Task 1. Next gate is the Raydium CPMM SDK decision (Task 2),
  which requires owner approval before any `npm install`.
