# solana-arb-bot

Solana atomic arbitrage bot — **Phase 1: devnet mechanics**. Correct first,
fast second. See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the mission,
[docs/NEVER_DO.md](docs/NEVER_DO.md) for the hard rules, and
[docs/adr/](docs/adr/) for why things are the way they are.

## What it does

Watches a SOL/USDC pool on Raydium (CPMM) and Orca (Whirlpool), detects
cross-DEX price gaps with fee-aware constant-product math, builds ONE atomic
transaction containing both legs (buy cheap, sell expensive), **always**
simulates it first, and only sends if simulation passes and net profit clears
the configured threshold. Every attempt — detected, aborted, sent — is
appended to `logs/attempts.jsonl` with the gap, the real simulation result,
and the reason.

Profitability is also enforced on-chain: the sell leg's minimum-out is set to
`quoteIn + MIN_PROFIT_THRESHOLD_QUOTE`, so if state moved, the whole
transaction reverts atomically.

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
npm test          # 89 tests: AMM math, detection, executor gate, fee estimate, seed plan, decoders, limiter…
npm run typecheck
```

## Module map (data-source / detection / execution / logging are separate)

| Module | Role |
|---|---|
| `src/datasource/` | `PriceSource` interface + polling & synthetic adapters, rate limiter |
| `src/decode/` | raw account → typed state (offsets verified against upstream) |
| `src/math/`, `src/detect.ts` | pure, fully-tested AMM math and gap detection |
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
