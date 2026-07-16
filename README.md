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

Known-good devnet pools for the WSOL/devUSDC pair (verified 2026-07-16, see
`npx tsx scripts/probe-devnet-pools.ts`):

```
RAYDIUM_POOL_ADDRESS=EEKfr2PBBhv3Rzz4ezGGZamPyHLC4VSnooj2myo8mdH7
ORCA_POOL_ADDRESS=3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt
QUOTE_MINT=BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k   # devUSDC
```

Devnet pool liquidity is dust-sized; keep `TRADE_SIZE_QUOTE` tiny (e.g.
`50000` = 0.05 devUSDC) or detection will correctly price-impact itself out
of every opportunity.

## Tests

```bash
npm test          # 68 tests: AMM math, detection, executor gate, decoders, limiter…
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
