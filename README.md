# solana-arb-bot

A Solana atomic cross-DEX arbitrage bot, built as a staged research project
with one hard rule: **correct first, fast second — and no real capital until
the strategy proves itself on real data.**

It watches a SOL/USDC pool on two DEXes (Raydium and Orca), detects fee-aware
price gaps with constant-product / concentrated-liquidity math, and builds a
single atomic transaction that executes both legs (buy cheap, sell expensive)
or reverts entirely. Every send is simulated first; every attempt — detected,
aborted, or sent — is appended to `logs/attempts.jsonl` with the gap, the real
simulation result, and the decision.

## TL;DR for a reviewer

- **Correctness-first execution.** One atomic two-leg transaction;
  `simulateTransaction` is mandatory before every send (ADR-0005); the compute
  budget is measured from simulation, never guessed. Profit is enforced three
  ways — at detection, re-checked in the executor, and encoded on-chain in the
  sell leg's minimum-out, so the whole transaction reverts atomically if state
  moves between detect and land.
- **Honest cost accounting.** Profit math includes both pool fees, the priority
  fee, and a modeled Jito tip — not just the raw price gap, which is the #1
  documented failure mode in comparable open-source bots (ADR-0009).
- **Swappable data layer behind one interface** (ADR-0006): synthetic → devnet
  polling → mainnet polling, so detection logic never changes when the data
  source does.
- **Detection and the on-chain safety guard are both Rust** (ADR-0011,
  ADR-0012): `rust/arb-math` ports both the sell leg's minimum-out guard
  (`u64`, overflow-checked, matching the real on-chain field width) and
  the full `detect()` opportunity-decision — both-direction AMM math,
  fee/threshold comparison, gap-bps diagnostic. `src/main.ts`'s live
  polling loop calls the Rust implementation every cycle; the original TS
  implementation stays in the repo as the tested reference a parity suite
  checks the Rust port against.
- **173 passing tests** across AMM math, gap detection, the executor send-gate,
  fee estimation, account decoders, the rate limiter, and the Rust port
  (21 `cargo test` cases plus TS/Rust parity suites); strict TypeScript,
  `tsc --noEmit` clean.
- **Decisions are documented, not just made:** 12 ADRs, per-phase docs, and
  dated session logs explain *why* the code is shaped the way it is.

## Result: a documented NO-GO (the point, not a failure)

Phase 1 reached verified live **devnet** arbitrage sends (8 txs finalized,
+0.288 devUSDC net, 2026-07-16). Phase 2 then ran the strategy in **mainnet
shadow mode** — reading real pool state and simulating real opportunities, but
structurally unable to send (ADR-0008) — across two structurally different
venues for ~200 combined hours and ~97,000 cycles.

The result was **zero net-profitable opportunities**, consistently, on both
venues. Rather than rationalize past a go/no-go bar that was written down
*before* the data arrived, the project concluded Phase 2 with an explicit
**NO-GO** (ADR-0010) and did not advance to risking real capital. Knowing when
*not* to deploy money — and building the instrumentation that lets you prove
it — is the deliverable.

## How to read this repo

| Start here | Why |
|---|---|
| [PROJECT_BRIEF.md](PROJECT_BRIEF.md) | mission, locked decisions, phased roadmap |
| [docs/adr/](docs/adr/) | every significant decision + rationale (start with 0005, 0008, 0009, 0010) |
| [src/executor.ts](src/executor.ts) | the single send path: simulate → abort or send |
| [src/detect.ts](src/detect.ts) + [src/math/](src/math/) | pure, fully-tested gap detection and AMM math |
| [docs/sessions/](docs/sessions/) | dated work logs: what was built, what worked, what's left |
| [docs/NEVER_DO.md](docs/NEVER_DO.md) | the hard safety rules, enforced in code |

## Setup

```bash
npm install
cp .env.example .env   # then fill in HELIUS_API_KEY (or RPC_URL)
```

Get faucet SOL for the generated wallet (the pubkey is printed at startup):

```bash
solana airdrop 2 <WALLET_PUBKEY> --url devnet
# or use https://faucet.solana.com
```

For the Orca leg you'll also want devnet test tokens (devUSDC) from Orca's
Tour de Whirlpool faucet — see https://dev.orca.so (Obtain SOL and Tokens).
Trading legs additionally require the wallet's associated token accounts
(WSOL + devUSDC) to exist; without them, simulation fails and the bot aborts
(and logs it) — which is the designed behavior, not a crash.

## Running

Two data sources implement the same `PriceSource` interface (ADR-0006):

**Synthetic** — scripted snapshots with one engineered gap; proves the whole
pipeline (detect → build → simulate-against-real-devnet → abort/send → log)
deterministically:

```bash
DATA_SOURCE=synthetic npm start
```

**Polling** — real devnet accounts, one batched RPC read per cycle, capped
well under the Helius free-tier 10 req/s:

```bash
DATA_SOURCE=polling npm start
```

### Seeding a controllable arb (our own Raydium pool)

Third-party devnet pools are dust and mostly priced together, so a real
opportunity rarely appears. `scripts/seed-devnet-pools.ts` creates OUR OWN
Raydium CPMM WSOL/devUSDC pool at a deliberately different price, so the bot
can find and execute a real gap. It uses the pure, unit-tested spend logic
in `src/seed/plan.ts` (mainnet refusal, non-dust floor, balance guard) and
is idempotent (persists addresses to `data/seeded-pools.devnet.json`).

```bash
npx tsx scripts/seed-devnet-pools.ts
```

A new WSOL/devUSDC **Orca** whirlpool cannot be created on devnet (all
fee-tier tick spacings already have pools), so the script adopts the
existing deep Orca pool `3KBZiL2g…` as the second venue; the price gap comes
from our Raydium pool. (Need devUSDC first? `scripts/get-devusdc.ts` swaps a
little SOL for it through that Orca pool — there is no devUSDC faucet.)

### Live polling against the seeded pair

Point polling at the seeded pool addresses (see the output of the seed
script, or `data/seeded-pools.devnet.json`):

```bash
DATA_SOURCE=polling \
RAYDIUM_POOL_ADDRESS=2yYGrgMKWk5p3f8PSFfUmu2Wz1VMo4au9wRTtBzPre3r \
ORCA_POOL_ADDRESS=3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt \
BASE_MINT=So11111111111111111111111111111111111111112 \
QUOTE_MINT=BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k \
BASE_DECIMALS=9 QUOTE_DECIMALS=6 \
TRADE_SIZE_QUOTE=20000 MIN_PROFIT_THRESHOLD_QUOTE=5000 \
SLIPPAGE_TOLERANCE_BPS=100 MAX_RPS=8 POLL_INTERVAL_MS=1500 \
npm start
```

This configuration produced the first verified live devnet arb sends on
2026-07-16 (8 txs finalized, +0.288 devUSDC net; see
`docs/sessions/2026-07-16-phase1-finish.md`). Keep `TRADE_SIZE_QUOTE` tiny —
the sell side (our Raydium pool) is intentionally shallow. `EST_TX_FEE_QUOTE`
is normally left unset: the fee is fetched live and converted per cycle
(ADR-0007).

Other known third-party devnet pools for this pair (dust; probe with
`npx tsx scripts/probe-devnet-pools.ts`): Raydium
`EEKfr2PBBhv3Rzz4ezGGZamPyHLC4VSnooj2myo8mdH7`.

## Tests

```bash
npm test          # 173 tests: AMM math, detection, executor gate, fee estimate, seed plan, decoders, limiter…
npm run typecheck
npm run build:rust  # builds rust/arb-math (also builds lazily on first use)
```

## Module map (data-source / detection / execution / logging are separate)

| Module | Role |
|---|---|
| `src/datasource/` | `PriceSource` interface + polling & synthetic adapters, rate limiter |
| `src/decode/` | raw account → typed state (offsets verified against upstream) |
| `src/math/`, `src/detect.ts` | pure, fully-tested AMM math and gap detection — TS reference implementation |
| `src/rustmath.ts`, `rust/arb-math/` | Rust crate: detection (ADR-0012) and the on-chain guard math (ADR-0011) — what `main.ts` actually calls, via a JSON CLI boundary |
| `src/txbuilder/` | the single atomic two-leg transaction |
| `src/executor.ts` | the ONLY send path: simulate → abort or send |
| `src/logger.ts` | JSONL attempt log |
| `src/main.ts` | wiring only |

## Safety rails (enforced in code, not just docs)

- Phase 1 refuses to start if config points at mainnet (`src/config.ts`).
- `simulateTransaction` before every send; compute budget measured from
  simulation, never guessed (`src/executor.ts`, tested).
- Min-profit threshold checked in detection, re-checked in the executor,
  and encoded on-chain in the sell leg's minimum-out.
- Client-side sliding-window rate limit ≤ `MAX_RPS` (hard cap 10/s).
- `.env`, `keypairs/`, `logs/` are gitignored.
