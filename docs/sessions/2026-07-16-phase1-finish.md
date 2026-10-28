# Session log — 2026-07-16 (attended, Phase 1 finish)

Continues from `2026-07-16.md` (overnight run) and the transfer handoff
(`docs/HANDOFF.md`). Owner is attending this session. Reordered plan:
(1) fee-default ADR + fix, (2) pool seeding, (3) live polling → real send.
All times UTC.

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
- Brainstormed SOL-vs-quote denomination first with the owner.
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

### 2b. Seed-plan pure logic — DONE (TDD)
`src/seed/plan.ts` + 9 tests (T22). `buildSeedPlan` derives per-pool
deposits from a target mid price + gapBps with exact bigint math, and
guards spend: mainnet refusal, non-dust floor, wallet-balance sufficiency.

### 2c. Live config discovered (not hardcoded)
- Orca devnet WhirlpoolsConfig `FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR`
  (read from the existing devnet pool's `whirlpoolsConfig` field).
- Canonical mint order A=WSOL, B=devUSDC → Orca/Raydium price = devUSDC per
  WSOL (matches our base/quote).
- Raydium devnet CPMM AmmConfig (index 0) PDA
  `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` (exists on-chain). Its
  `ApiCpmmConfigInfo` is reconstructed by decoding the on-chain account with
  `CpmmConfigInfoLayout` (the SDK's `api.getCpmmConfigs` is mainnet-only).

### 2d. Spend-plan pivot (owner-approved) — discovery
Acquiring devUSDC through the external Orca pool `3KBZiL2g…` is far more
expensive than projected: a 0.03 WSOL swap yielded only **0.66 devUSDC**
(that pool is thin/mispriced), so reaching ~10 devUSDC is impractical.
Since we set BOTH our own pools' prices, we pivoted (owner-approved) to
**thin pools + a large deliberate gap**: seed ~0.9 devUSDC + ~0.006 WSOL
per pool (total ~1.8 devUSDC, fits current balances) with an **800 bps**
gap so a tiny trade still nets clearly positive. This spends far LESS than
the originally approved ~5-devUSDC/pool plan.
- Balances after one top-up run: SOL 1.756, WSOL 0.15, devUSDC 1.99.
- devUSDC top-up txs (get-devusdc.ts):
  `4VAh6WAGaChFXeg2vd4KVqngaGixVSSFTZ4WJu18wx2DeDx8ngoSPJVkWDKLF5Uy3AyRxRLYLEnCGSTBKqKPFyi9`,
  swap `2NR29eAkUhbce6wegSSvgo7djezxqWLcXeQC2uPsLomVREH4eGNGVRfWwkjxagpyyWzF2FvwMrZ3Kked3vwz7wqC`.

### 2e. Seeding script — DONE (with a forced Orca deviation)
`scripts/seed-devnet-pools.ts` consumes `buildSeedPlan`, wraps SOL→WSOL if
needed, and is idempotent via `data/seeded-pools.devnet.json`.

- **Raydium CPMM pool CREATED (ours):**
  `2yYGrgMKWk5p3f8PSFfUmu2Wz1VMo4au9wRTtBzPre3r`
  (tx `2nhGCj4JLjTyjjrFPzyDai9x8iJWrsKj7WNq3D2XRYGHWN5umDwSYbrd8kQveBU8sVXqs9CkwE9XojAY4NLgEpdt`),
  seeded 0.006 WSOL / 0.828 devUSDC → price **138 devUSDC/SOL**. First
  attempt at AmmConfig index 0 failed (`Custom:0` — pool `EEKfr2…` already
  exists from earlier sessions); switched to index 2 (fresh PDA).
- **Orca side — could NOT create our own.** Every WSOL/devUSDC tick spacing
  with a fee tier on config `Fcrwe…` already has a pool; the one free
  spacing (96) has no fee tier (only Orca's authority can add one). Owner
  approved adopting the existing **deep** pool
  `3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt` (price **~22**, 373 WSOL /
  6234 devUSDC) as the second venue.
- **Balance-guard bug found + fixed via TDD:** after Raydium spent its
  devUSDC, `buildSeedPlan` still demanded both pools' balance. Added
  `alreadySeeded` so the guard only requires un-seeded pools (2 new tests;
  11 seedPlan tests total).

**Resulting arb setup:** our Raydium pool (138) vs deep Orca (22) → WSOL is
~6× cheaper on Orca. Executable direction: buy WSOL cheap on deep Orca,
sell into our overpriced (tiny) Raydium pool. A ~0.02-devUSDC trade nets
~+0.09 devUSDC — a large, robust gap for the one required live send.
Deviation from "seed both our own pools" is forced by devnet (all Orca
pools pre-exist) and owner-approved.

## Task 3 — Live send — DONE (verified on-chain)

Ran `src/main.ts` polling (DATA_SOURCE=polling) against
RAYDIUM_POOL_ADDRESS=2yYGrgM… vs ORCA_POOL_ADDRESS=3KBZiL2g…,
TRADE_SIZE_QUOTE=20000 (0.02 devUSDC), MIN_PROFIT_THRESHOLD_QUOTE=5000,
SLIPPAGE_TOLERANCE_BPS=100, MAX_RPS=8, POLL_INTERVAL_MS=1500.

**The bot detected the gap, simulated, and SENT real atomic arb txs.**
Each cycle: buy WSOL cheap on deep Orca, sell into our overpriced Raydium
pool, in ONE VersionedTransaction, simulate-gated first. **8 sends, all
finalized on-chain with `err: null`** (verified via `getSignatureStatuses`
+ `getTransaction`). First send:
`51RYVhyLPSJ6g7rFezVdB7gt3QijVnzuhGGWqygmb9rcgXXgWPcf2HogWNAB4R28noLxLJY9K9MaRByYsJ23R5HQ`
(slot 476737365, err null, both legs succeeded — Orca whirlpool +
Raydium CPMM `DRaycpLY18…`).

**Economic verification (not just a log line):**
- Wallet devUSDC **1.164986 → 1.453143 = +0.288 devUSDC** net profit.
- Fee estimate live path exercised: `base tx fee 5000 lamports (rpc); +20%
  headroom -> 6000 lamports (ADR-0007)`.
- The arb closed the gap: our Raydium pool moved **138 → 28.95
  devUSDC/SOL** (WSOL reserve 0.006→0.013, devUSDC 0.828→0.38) toward the
  market ~22 — the gap shrank each cycle (52205 → 5014 bps) exactly as a
  real arbitrage should. Bot stopped manually after 8 sends.

This is the final Phase-1 exit criterion. **Phase 1 Status → DONE.**

## Four-part summary

**WHAT I BUILT** — ADR-0007 + real-fetched tx-fee estimate (src/fee.ts,
per-cycle quote conversion, +20% headroom kept separate from the
threshold); `@raydium-io/raydium-sdk-v2` devDependency (owner-gated);
`src/seed/plan.ts` (TDD spend logic) + `scripts/seed-devnet-pools.ts`
(creates our Raydium CPMM pool, adopts the deep Orca pool).

**WHAT WORKS** — 89 unit tests pass; typecheck clean; live fee fetch on
devnet; our Raydium pool created and seeded; **8 real on-chain atomic arb
sends, all finalized err:null, +0.288 devUSDC net**, gap closed 138→28.95.

**WHAT'S LEFT** — Phase 1 is complete. Phase 2 (mainnet shadow mode) is the
next phase. Optional cleanup: README run-instructions for the seeding
script + the two-pool polling config (added this session).

**OPEN QUESTIONS / BLOCKERS** — none. One forced deviation, owner-approved:
we adopted an existing deep Orca pool as the second venue because a new
WSOL/devUSDC whirlpool cannot be created on devnet (all fee-tier tick
spacings already have pools). If Phase 1 must use a fully self-owned Orca
pool, that needs Orca's config authority to add a fee tier for a free tick
spacing — out of our control on this devnet config.

## WHAT'S LEFT (this session)
3. Live polling against seeded pools → an ACTUAL on-chain send (final
   Phase-1 exit criterion); verify with the real on-chain signature, not
   just a log line.

## OPEN QUESTIONS / BLOCKERS
- None for Task 1. Next gate is the Raydium CPMM SDK decision (Task 2),
  which requires owner approval before any `npm install`.
