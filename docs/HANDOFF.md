# Project Handoff

## Last updated
2026-07-26, ~02:41 UTC. **PHASE 1 DONE. PHASE 2 DONE — NO-GO.** The
`clmm-orca` cross-DEX shadow run (the one built specifically to produce
the real Phase-3 go/no-go signal) ran 84.7h / 55,245 cycles and returned
zero signal, same shape as the earlier two-Orca interim run. Stopped
cleanly on owner instruction, decision recorded in ADR-0010, and Phase 2
is now closed with an explicit, data-backed **no-go** on proceeding to
Phase 3 as currently scoped.

### PHASE 2 CONCLUSION — NO-GO (both tested venues)
- **Nothing is running.** `shadow-run-3-clmm-orca` was stopped via
  graceful `SIGINT` at **2026-07-26T02:41:13Z**
  (`stopping after current cycle…` → `source finished; exiting.`,
  confirmed zero processes remaining). No shadow run, and nothing else,
  is currently live in this project.
- **Final tally:** started 2026-07-22T13:58:56Z, ran **84.7h, 55,245
  cycles, 0 opportunities, 0 net-positive, 0 sends** — every single cycle
  a correct `no-opportunity`. `handoffMs` p50 53ms / p95 156ms throughout,
  no simulation failures. Frozen in `logs/attempts.jsonl`
  (`timestamp >= 2026-07-22T13:58:56Z`) and `logs/shadow-run-3-clmm-orca.log`.
- **Combined with the two-Orca result** (42,323 + 30,064 cycles, also
  0/0/0, see below), this is a **second, independent, confirmed
  zero-signal finding** — on a structurally different, genuinely
  cross-DEX venue, not explained away by "two pools tracking too
  closely."
- **Decision recorded: ADR-0010**
  (`docs/adr/0010-clmm-orca-zero-signal-phase2-conclusion.md`). Judged
  against the owner's pre-committed bar (a few genuinely net-profitable
  opportunities/day, consistently across multiple days, via
  `netPositive`) — **not met on either tested venue.** Phase 2's exit
  criteria are now all checked in
  `docs/phases/phase-2-mainnet-shadow-mode.md` (Status: **DONE**).
- **What this means going forward:** proceeding to Phase 3 (real capital,
  real sends) is NOT justified by the data collected. Whether to pursue a
  broader search — different pairs, other venues, larger trade sizes, or
  a Jito-bundle-competitive redesign — is an open scope question for the
  owner, not decided here (see ADR-0010 "Risks"). **Do not restart this
  same SOL/USDC two-venue experiment expecting a different answer** —
  read ADR-0010 first.
- Full write-up: `docs/sessions/2026-07-26.md`.

Earlier state (as of the 2026-07-22 cutover, when the run above was just
starting) preserved below for historical context.

## Last updated (prior)
2026-07-22, ~13:59 UTC. **PHASE 1 DONE. PHASE 2 MOSTLY DONE, CROSS-DEX
SIGNAL RUN NOW LIVE.** The two foundational pieces (a trustworthy latency
metric, the real cross-DEX venue) were built, verified, and merged earlier
today; this update covers cutting the live shadow run over from the
two-Orca interim to `clmm-orca` — the run that produces the actual Phase-3
go/no-go signal — and recording the owner's go/no-go bar in advance.

### WHAT IS CURRENTLY RUNNING (live, right now)
- **`shadow-run-3-clmm-orca`** — the real cross-DEX shadow run: Raydium
  CLMM vs Orca whirlpool, mainnet. Background `npm exec tsx src/main.ts`,
  log `logs/shadow-run-3-clmm-orca.log`, start marker
  `logs/shadow-run-3-clmm-orca.start` (**2026-07-22T13:58:56Z**).
  `VENUE=clmm-orca`, `mainnet-beta`, `polling`, PHASE=2, send structurally
  disabled (ADR-0008). Wallet `AN2ovAtpnHhMc2yVSYwZkZMVTEF8iwbrYPFQVeKKQebs`.
  Venue: CLMM pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv` (4 bps,
  $5.9M TVL) vs Orca whirlpool `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`
  (4 bps, $32.5M TVL). `SURROGATE_OWNER=MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa`
  is set (same funded wallet used in the clmm-orca smoke-check) so that if
  a real opportunity appears, its simulation reflects real ATA/business
  logic rather than failing on the unfunded local wallet — **the first
  10-second launch attempt omitted this and was killed and restarted**;
  see `logs/shadow-run-3-clmm-orca.aborted-no-surrogate.log` for that
  short-lived, zero-opportunity, zero-send artifact.
- **No fixed run duration was set this time** (owner asked for "at least
  72 hours" — treat that as a floor, not an auto-stop; check back in and
  decide based on the data, don't just kill it at the 72h mark
  mechanically). Stop with `pkill -f "tsx src/main.ts"` when ready to
  analyze a closed window.
- **Go/no-go bar recorded in advance** (owner, 2026-07-22, before seeing
  any `clmm-orca` results): a few genuinely net-profitable opportunities
  per day, consistently across multiple days — not a one-off spike.
  Judged against `netPositive` (from `scripts/shadow-stats.ts`) converted
  to a per-day rate, NOT the raw `opportunitiesPerHour` figure (that only
  reflects a loose base-fee-only detect-time gate). Full methodology
  recorded in `docs/phases/phase-2-mainnet-shadow-mode.md` ("Phase-3
  go/no-go bar").

### WHAT WAS RETIRED THIS UPDATE
- **`shadow-run-2`** (two-Orca on the handoffMs-corrected code) — stopped
  cleanly via `SIGINT` at 2026-07-22T13:57Z (`stopping after current
  cycle…` → `source finished; exiting.`, confirmed graceful, zero sends
  throughout its life). Final tally: started 2026-07-20T17:20:33Z, ran
  ~44.6 h, **29,565 cycles, ALL `no-opportunity`, ZERO sends** — same
  zero-signal picture as the closed 72h run (gaps oscillate −1…+2 bps; a
  round trip nets ≈ −1.04 USDC, below the 0.01-USDC threshold). **30,064
  cycles** total (grep-verified against the frozen log), 0 opportunities,
  0 sends. Log frozen at `logs/shadow-run-2-corrected.log`. Its purpose
  (proving the `handoffMs` fix live + confirming a healthy pipeline) was
  already served before this stop.

### WHAT'S DONE SINCE THE 2026-07-17 HANDOFF

**Two-Orca 72h run — FINAL, documented ZERO-signal finding.** Ran
2026-07-17T17:13:37Z → its scheduled 72h close 2026-07-20T17:13:37Z.
Window analysed 71.8 h, **42,323 cycles: 0 opportunities (gross or net),
0 sends** — every cycle a correct `no-opportunity`. Frozen dataset
`logs/attempts-72h-two-orca.jsonl`; full write-up in
`docs/phases/phase-2-mainnet-shadow-mode.md` ("Run result — two-Orca
venue, FINAL"). This is useful NEGATIVE data, not a failure: two deep
same-pair Orca pools stay aligned (~0–2 bps) while a round trip costs
~1 USDC, so the gap never clears cost. Confirms the need for a **cross-DEX**
venue to produce a real go/no-go signal.

**`handoffMs` (was `dataAgeMs`) latency bug — FIXED & live-verified.**
Root cause: the snapshot timestamp was stamped *after* the RPC round-trip,
and `onPair` ran synchronously, so the metric measured a sub-ms
receipt→detect handoff (floored to 0; p50=p95=0, 96%+ exactly 0) rather
than data staleness — and would have read ≈0 for Geyser too, defeating the
planned polling-vs-Geyser comparison. Fix (`19975fd`, merged at window
close `8077933`): field renamed `fetchStartedAtMs`, stamped immediately
*before* the batch RPC read in both polling sources; the record field
`dataAgeMs` → `handoffMs` (acquisition→decision latency). Live-verified on
the restart: real varied values (49/55/121/149/293/1416 ms). Documented as
NOT capturing poll-interval sampling lag (separate, deferred metric).

**Raydium CLMM cross-DEX venue — BUILT, TESTED, MERGED (three stacked
deliverables, Option 1).** This is the venue that can finally produce a
real cross-DEX signal — Raydium CLMM vs Orca whirlpool, the arbitrage the
strategy actually targets.
1. **CLMM decoder + math foundation** (`ade7628`) — `decode/clmm.ts`
   (`decodeClmmPool`, `decodeClmmAmmConfigFeeBps`), `toClmmSnapshot`
   adapter reusing the unchanged whirlpool spot-math with ZERO `detect.ts`
   change. Offsets dual-source-verified (pinned raydium-clmm `@03b44b7` +
   live pool `3ucNos…Uxv`, $5.9M/4bps); SOL is `mint_0` (normal
   orientation).
2. **CLMM `swap_v2` instruction builder** (`659716f`, T49–T51) —
   `buildClmmSwapV2Ix` + tick-array/bitmap PDA helpers
   (`src/txbuilder/raydiumClmm.ts`). Live mainnet sim `err:null`,
   44,028 CU. The sim caught a real on-chain bug: the deployed program
   rejects the exact `MIN`/`MAX_SQRT_PRICE_X64` boundary, so the client
   must send `MIN+1`/`MAX−1` — fixed and re-verified against live source
   and the vendored SDK.
3. **`clmm-orca` runnable venue** (`3964374`, +8fd29d6) — wires the two
   foundations into a live venue. `buildClmmOrcaArbTransaction`
   (`src/txbuilder/clmmOrca.ts`, one atomic tx: CLMM leg + Orca leg, shared
   SOL/USDC ATAs), `ClmmOrcaPollingSource`
   (`src/datasource/clmmOrcaPolling.ts`, one batched `getMultipleAccounts`
   per cycle, CLMM fee resolved once at startup from the AmmConfig),
   `VENUE=clmm-orca` config/validation, `setUpClmmOrca` + `.env.example`
   block. **REAL PROOF via mainnet simulation** (read-only,
   `scripts/smoke-clmm-orca-arb-sim.ts`): both direction assignments reach
   BOTH program IDs and produce well-formed txs; the follow-up `8fd29d6`
   sizes the sell leg from the probed buy-leg output so both legs execute
   at realistic size (closing the earlier `baseOut=1n` gap). Built via
   subagent-driven TDD in an isolated worktree; per-task + whole-branch
   reviews; 159 tests pass, typecheck clean. Isolation held —
   additive-only, zero edits to any do-not-touch file, live `shadow-run-2`
   untouched.

### WHAT'S LEFT IN PHASE 2 (operational, not code)
1. ~~Cut the live shadow run over from `orca-orca` to `clmm-orca`~~ —
   **DONE 2026-07-22T13:58:56Z**, see `shadow-run-3-clmm-orca` above.
2. **Let it run and check in against the owner's go/no-go bar** (a few
   genuinely net-positive opportunities/day, consistently across multiple
   days — see above and the phase-2 doc). Use `npx tsx
   scripts/shadow-stats.ts --cluster mainnet-beta --since <window>` across
   multiple non-overlapping windows, not just the cumulative total.
3. **Capture ADR-0010** ("Raydium CLMM as cross-DEX shadow venue") once
   the run produces its first signal (or a clean negative, symmetrically
   with the two-Orca finding).
4. Then the Phase-2 exit criteria (real detection-rate data + explicit
   data-backed Phase-3 decision) can finally be marked met.

### STILL-STANDING CAVEATS
- **Geyser gRPC** (`src/datasource/geyser.ts`) is code-complete but NOT
  runnable — needs an owner-procured endpoint (money item; not on Helius
  free tier) and is not wired for any venue yet.
- Send path stays hard-disabled (ADR-0008, 3 layers + unsigned shadow txs)
  through all of Phase 2. PHASE≥3 refuses to start. Zero mainnet sends
  ever, grep-verified.

Earlier baselines below left intact for reference.

## Last updated (prior)
2026-07-16, ~19:15 UTC. Attended session (see
`docs/sessions/2026-07-16-phase1-finish.md`). **PHASE 1 IS DONE** — all
three tasks complete and the final exit criterion is met with verified
on-chain evidence:
1. EST_TX_FEE_QUOTE now derives from a real `getFeeForMessage` fetch (+20%
   headroom, kept separate from the threshold), converted per cycle —
   ADR-0007 accepted after owner review (`src/fee.ts`).
2. Pool seeding: created our own Raydium CPMM pool
   `2yYGrgMKWk5p3f8PSFfUmu2Wz1VMo4au9wRTtBzPre3r` (~138 devUSDC/SOL) via the
   owner-approved `@raydium-io/raydium-sdk-v2` devDependency; adopted the
   existing deep Orca pool `3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt`
   (~22) as the second venue (a new WSOL/devUSDC whirlpool can't be created
   on devnet). Spend logic TDD'd in `src/seed/plan.ts`.
3. Live send: **8 real atomic arb transactions, all finalized `err:null`**,
   wallet devUSDC +0.288 net, gap closed 138→28.95. First sig
   `51RYVhyLPSJ6g7rFezVdB7gt3QijVnzuhGGWqygmb9rcgXXgWPcf2HogWNAB4R28noLxLJY9K9MaRByYsJ23R5HQ`.

89 unit tests pass; typecheck clean. Next phase: Phase 2 (mainnet shadow
mode). Seeded venue addresses persisted in `data/seeded-pools.devnet.json`.

Earlier baselines below left intact for reference.

## Last updated (prior)
2026-07-16, ~13:50 UTC. Reflects the state right after the "final commit
before transfer" commit (`eff477d`) and a follow-up session that read
project docs and confirmed live wallet balances but wrote no code.

## Where things stand right now

**Phase**: Phase 1 — Devnet Mechanics (`docs/phases/phase-1-devnet-mechanics.md`).
**Status field in that file**: `IN PROGRESS — code complete, awaiting owner
review + one live send demo`. This is still accurate — nothing in this
handoff changes that status.

**Exit criteria** (from `phase-1-devnet-mechanics.md`), with evidence:

| Criterion | Met? | Evidence |
|---|---|---|
| Runs on devnet without errors | Yes | `docs/sessions/2026-07-16.md` T17/T18 run logs |
| Detects a synthetic/test opportunity | Yes | synthetic −300bps cycle + live −2954bps devnet gap, both logged (session log JSONL excerpts) |
| Every send path through simulateTransaction | Structurally yes, **not exercised live** | single gate in `src/executor.ts` (grep-verified, only `sendRawTransaction` call site), 5 unit tests in `tests/executor.test.ts` pin abort behavior. **No real on-chain send has ever happened in this project.** |
| Every attempt logged | Yes | `logs/attempts.jsonl` (gitignored, exists locally, 52KB as of this check) |
| Clean module separation | Yes | `src/datasource/`, `src/detect.ts`, `src/txbuilder/` + `src/executor.ts`, `src/logger.ts` only import types from each other; `src/main.ts` is the sole wiring point |

The one exit criterion NOT met: **a live, actually-sent, on-chain
transaction on devnet.** Everything downstream of "would send" has been
built and unit-tested (68 tests, `npm test` passes), but no send has been
demonstrated. This is explicitly deferred per `docs/NEVER_DO.md` ("never
invent/mock a successful trade result") — the project has correctly
refused to claim this is done without evidence.

Also not done: **owner review of ADRs 0001–0006.** All six were written
and marked `accepted` unattended, per an explicit standing instruction to
do so — but per `docs/sessions/2026-07-16.md` they still await the
owner's actual read-through. Treat them as provisional until the owner
says otherwise.

**Wallet in use**: `FeRGsxw2jjTtSfta4Gy5JdNDaVBrWJyUKeogEVRiE2PB`
(keypair at `keypairs/devnet.json`, gitignored, generated by
`src/wallet.ts` on first run).

**Live funding state, checked via RPC against devnet just before writing
this doc** (not from memory):
- SOL: **1.83588144**
- WSOL: **0.1** (ATA `CK6HwhZsZifL3ZrixWeEosGgTGqkDnZrma9jNhBeAQzA`)
- devUSDC: **1.328665** (mint `BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k`,
  ATA `7fm9o8dacFfqctaixPs8uRAHPVw2QStowSBdM4mTfY9u`)

devUSDC was obtained via `scripts/get-devusdc.ts` (wraps SOL into WSOL,
then swaps WSOL for devUSDC through the live Orca SOL/devUSDC
Tour-de-Whirlpool pool `3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt` —
there is no separate devUSDC faucet website). It was run twice this
session-set, which is why the balance reflects two wrap+swap cycles.

**Git state**: clean working tree, `master` up to date with
`origin/master` (`https://github.com/bhavi-g/solana-arb-bot.git`), HEAD =
`eff477d "final commit before transfer"`. No uncommitted work exists
anywhere in the repo as of this check.

## What was IN PROGRESS when this session ended

The owner gave a 3-part instruction for finishing Phase 1:

1. Seed real, non-dust liquidity into our own devnet Raydium CPMM + Orca
   Whirlpool pools (TDD the seeding script first).
2. Fix `EST_TX_FEE_QUOTE` to be derived from real fetched devnet fee data
   instead of the hardcoded `1000` default — brainstorm SOL-vs-quote-token
   denomination first, then write an ADR for the decision.
3. Run live polling against the seeded pools until a real opportunity
   triggers an **actual send** — the final Phase-1 exit criterion — and
   verify it with the real on-chain signature, not just a log line.

**What was actually done toward this**: research only. I confirmed the
Superpowers plugin and its skills were active, and read
`PROJECT_BRIEF.md`, `docs/NEVER_DO.md`, `docs/phases/phase-1-devnet-mechanics.md`,
`docs/sessions/2026-07-16.md`, and the ADR index
(`docs/adr/README.md` — titles/status of all six ADRs). I had just started
reading individual ADR files to confirm the numbering convention for a new
ADR-0007 when the session was interrupted to write this handoff instead.

**Not started at all**:
- No pool-seeding script exists (`scripts/` currently only has
  `probe-devnet-pools.ts` and `get-devusdc.ts` — both read-only or
  wrap/swap utilities, neither creates a pool).
- No tests were written for pool-seeding logic.
- No devnet pools have been created or seeded by us — the bot has so far
  only read pre-existing, dust-liquidity third-party devnet pools (see
  `docs/sessions/2026-07-16.md` OPEN QUESTIONS: "devnet pool liquidity is
  dust (2.34 devUSDC in the best Raydium pool)").
- `EST_TX_FEE_QUOTE` is still the hardcoded default of `1000` in
  `src/config.ts` (`BigInt(env.EST_TX_FEE_QUOTE ?? "1000")`). No
  brainstorming happened, no ADR-0007 was drafted.
- No live send has been attempted. `logs/attempts.jsonl` contains no
  `"action":"sent"` entries from a real run (only from unit tests, which
  don't touch this file).

**Is it safe to just re-run the same prompt?** Yes. Nothing was left
half-written — no partial script, no broken test, no uncommitted diff.
The only "progress" was documents read into context, which the next
session can re-read itself (see below). Re-running the original prompt
verbatim is safe and will start clean from step 1.

One thing worth flagging to whoever runs it next: pool creation on both
Raydium CPMM and Orca Whirlpool is nontrivial to hand-roll (tick arrays,
oracle PDAs, AmmConfig references, vault/LP-mint PDAs). The Orca side can
likely reuse `@orca-so/whirlpools-sdk` (already a devDependency, added and
verified working for the `get-devusdc.ts` swap script). The Raydium CPMM
side has **no SDK installed yet** — `@raydium-io/raydium-sdk-v2` or
equivalent will likely need to be added, the same way the Orca SDK was
added last session (see "Do not repeat these mistakes" below for the
verification steps that took).

## What to do next (copy-pasteable)

Run this prompt verbatim to continue:

```
Confirm the superpowers plugin and its skills are loaded before starting
(you should see using-superpowers active). Read PROJECT_BRIEF.md,
docs/NEVER_DO.md, docs/phases/phase-1-devnet-mechanics.md, and the latest
session log in docs/sessions/ before doing anything.

The wallet FeRGsxw2jjTtSfta4Gy5JdNDaVBrWJyUKeogEVRiE2PB is now funded with
devnet SOL and has WSOL + devUSDC token accounts with real balances.

Remaining work for Phase 1:

1. Seed our own devnet pools (Raydium CPMM + Orca Whirlpool) with real,
   non-dust liquidity so detection and execution can be tested against
   something realistic. Use superpowers:test-driven-development — write
   tests for the seeding script before running it against real devnet
   funds.

2. Set EST_TX_FEE_QUOTE properly: fetch real recent devnet fee data and
   compute a sound default with headroom, instead of a hardcoded guess.
   Use superpowers:brainstorming briefly on whether this should be
   SOL-denominated or converted to quote-token units, and document the
   choice as an ADR.

3. Run live polling against the seeded pools. When a real profitable
   opportunity is detected, let the full flow proceed to an ACTUAL SEND —
   this is the final Phase 1 exit criterion. Use
   superpowers:verification-before-completion before declaring this done:
   show me the actual on-chain transaction signature and result, not just
   a log line.

Update docs/adr/ with the fee-default ADR from item 2.

At the end, update the session log with the four-part summary, and mark
phase-1-devnet-mechanics.md Status as DONE only if every exit criterion
has real evidence, including the live send.
```

Before running it, re-check current wallet balances yourself (devnet
state may have drifted) rather than trusting the numbers in this doc.

## Environment notes

**Tools to verify/install before continuing** (all three were needed last
session; check they're still present on whatever machine picks this up):

1. **Superpowers plugin** — install (or confirm already installed) with:
   ```
   /plugin install superpowers@claude-plugins-official
   ```
   Note from experience: an earlier session concluded this plugin was
   "unavailable in this environment" and worked around it manually; a
   later session found it was in fact already installed globally. Don't
   trust a prior session's negative conclusion — check fresh.

2. **`architecture-decision-records` skill** — no install needed. It is
   committed in this repo at
   `.claude/skills/architecture-decision-records/SKILL.md` (tracked in
   git since commit `77b4704`), so it comes for free with `git clone`.

3. **Context7 MCP** — this is a **project-scoped** MCP server entry in the
   global `~/.claude.json`, keyed by absolute project path. It will NOT
   carry over to a clone at a different path or a different machine.
   Re-add it from inside the project directory with:
   ```
   claude mcp add context7 -- npx -y @upstash/context7-mcp
   ```

**`.env` and `keypairs/` are gitignored** and must be manually recreated
on any new machine. `.env` needs these keys (see `.env.example` for the
full annotated template — names only below, no real values):

```
PHASE
CLUSTER
HELIUS_API_KEY        (or RPC_URL as an alternative)
KEYPAIR_PATH
DATA_SOURCE
TRADE_SIZE_QUOTE
MIN_PROFIT_THRESHOLD_QUOTE
SLIPPAGE_TOLERANCE_BPS
MAX_RPS
POLL_INTERVAL_MS
EST_TX_FEE_QUOTE            (optional, defaults to 1000 — see above, this is what item 2 above should fix)
RAYDIUM_CPMM_PROGRAM_ID     (optional override)
ORCA_WHIRLPOOL_PROGRAM_ID   (optional override)
RAYDIUM_POOL_ADDRESS        (required when DATA_SOURCE=polling)
ORCA_POOL_ADDRESS           (required when DATA_SOURCE=polling)
BASE_MINT                   (required when DATA_SOURCE=polling)
QUOTE_MINT                  (required when DATA_SOURCE=polling)
BASE_DECIMALS                (required when DATA_SOURCE=polling)
QUOTE_DECIMALS               (required when DATA_SOURCE=polling)
```

`keypairs/devnet.json` holds the raw secret key array for
`FeRGsxw2jjTtSfta4Gy5JdNDaVBrWJyUKeogEVRiE2PB`. If it's missing,
`src/wallet.ts` will silently generate a brand-new (unfunded, empty)
keypair on next run — that would NOT be the same wallet referenced
throughout this doc and the session logs. Transfer the actual keypair
file out-of-band if continuing on a new machine; don't let it regenerate.

**This project is devnet-only, no real money, per `docs/NEVER_DO.md`.**
Phase 1 explicitly forbids touching mainnet; `src/config.ts` enforces this
as a startup guard, not just a convention.

## Do not repeat these mistakes

1. **Don't assume a tool/plugin is unavailable based on a past session's
   conclusion.** The 2026-07-16 unattended session concluded Superpowers
   couldn't be installed and worked around it manually (see that session
   log's "Process deviations" section). A later session found `/plugin
   install superpowers@claude-plugins-official` reported it was already
   installed globally. Environment state changes between sessions —
   re-verify, don't inherit the old conclusion.

2. **There is no devUSDC faucet website.** Don't go looking for one or
   guess a URL. Orca's own docs (and this project's experience) confirm
   devUSDC is obtained by swapping devnet SOL for it through the live
   Orca Tour-de-Whirlpool SOL/devUSDC pool
   (`3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt`) — see
   `scripts/get-devusdc.ts`. This required wrapping SOL into WSOL first
   (`createSyncNativeInstruction`), since the pool trades WSOL, not native
   SOL.

3. **Don't trust a phrase like "whichever SDK we already have" —
   check `package.json` yourself.** When asked to use "whichever Orca SDK
   we already have as a dependency," neither `@orca-so/whirlpools-sdk`
   nor `@orca-so/whirlpools` was actually installed. Verify with
   `package.json`/`node_modules` before writing code against an assumed
   dependency. When a new SDK genuinely is needed: prefer
   `@orca-so/whirlpools-sdk` (Anchor-based, built on `@solana/web3.js` v1,
   which this project already uses) over the newer `@orca-so/whirlpools`
   v2 SDK (built for `@solana/kit`, an incompatible second web3 stack).
   Installing it required bumping `@solana/web3.js` 1.98.0 → 1.98.4 to
   satisfy a peer-dependency range, and then re-pinning all new
   dependencies to exact versions (no `^`) to match this repo's existing
   pinning convention in `package.json` — check that convention before
   `npm install`-ing anything new here.

4. **Devnet mint addresses aren't written down anywhere in this repo as
   constants — they're discovered live.** The devUSDC mint
   (`BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k`) was found by actually
   running `scripts/probe-devnet-pools.ts` against the live Orca pool and
   reading `mintB` from the decoded on-chain account, not from any
   training-data memory of a "well-known" address. Devnet deployments are
   ephemeral test data — always verify live rather than recalling from
   memory.
