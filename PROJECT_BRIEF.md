# Solana Arbitrage Bot — Project Brief (Full Reference)

## Mission
Build a Solana atomic arbitrage bot as a staged, serious learning project —
correct first, fast second. Eventually moves to real mainnet capital, but
only after each stage proves itself on real data with no money at risk.

## Locked architectural decisions
- Language: TypeScript + @solana/web3.js (Rust only if/when a later phase
  proves latency is the bottleneck)
- RPC provider: Helius to start (free tier), config-swappable later
- Commitment level: "processed" for all reads and confirmations — atomic
  arbitrage reverts on failure anyway, so "confirmed"/"finalized" only add
  latency without adding safety
- Devnet vs mainnet is a CONFIG SWITCH (.env), never a code fork
- simulateTransaction is MANDATORY before every send, no exceptions; abort
  if simulation fails or shows the trade isn't profitable after fees
- Every attempt (successful, aborted, reverted) is logged with: timestamp,
  detected gap, simulated result, sent-or-aborted, and why
- Secrets (Helius key, wallet key) live only in .env, gitignored from
  commit 1, never pasted into chat or committed

## Core mechanism (why this works)
Atomic arbitrage = both legs of a trade (buy on DEX A, sell on DEX B) happen
inside ONE transaction. If the numbers don't work out, the whole transaction
reverts and nothing happens except a tiny fee. Classic pattern: an AMM (like
Orca or Raydium, which price based on pool reserves) has a stale quote after
the market moved, while an orderbook DEX (like Phoenix) has already updated.
The bot buys cheap on the stale side, sells on the updated side.

Realistic expectations: per-trade profit is tiny (cents, not dramatic wins).
Historical Solana-wide data: ~90 million successful arbitrages in one year
at an average profit of about $1.58 each. This is a high-frequency,
low-margin business, and viral "$1 to $400k" stories are outliers, not the
norm — most bots in this space lose money once infrastructure costs are
counted.

## DEXs in scope
- Raydium (CPMM/legacy AMM, and CLMM) — deep liquidity, constant-product math
- Orca (Whirlpools, concentrated liquidity AMM)
- Phoenix (fully on-chain central limit orderbook, "crankless" — instant
  atomic settlement) — the natural pairing against AMM staleness
- Jupiter (aggregator, not a pool) — useful later for route discovery, but
  avoid depending on the public hosted API in the actual trading hot path;
  a self-hosted instance is the later, faster option

## Data infrastructure roadmap (do NOT skip stages)
1. Public/free-tier polling (devnet + early mainnet shadow mode) — good
   enough to learn on, too slow to compete on
2. WebSocket subscriptions — better, still not competitive
3. Yellowstone/Geyser gRPC streaming — sub-50ms, what real competitive bots
   use; only needed once we're validating real strategy performance
Architect the price-scanning module with a clean interface boundary so we
can swap the data source (poll → WebSocket → gRPC) without rewriting
detection logic.

## Execution safety rules (non-negotiable, all phases)
- simulateTransaction before every send
- "processed" commitment
- Compute unit budget measured via simulation, not guessed
- Never send if simulated profit is below the configured minimum threshold
- Wallet holding real funds (mainnet phase) only ever holds the minimum
  needed for active trading — never savings

## Phased roadmap
- Phase 1 (devnet): correct mechanics — scan, detect, build atomic tx,
  simulate, log. No mainnet, no real money, no Jito.
- Phase 2 (mainnet SHADOW MODE): read real mainnet pool state, detect and
  simulate real opportunities, log everything — but NEVER submit a real
  transaction. Purpose: see if the strategy finds anything real before
  risking a cent.
- Phase 3 (small-capital live mainnet): only after Phase 2 shows real,
  simulated-profitable opportunities. Tight guardrails: small notional
  caps, daily loss limit, kill switch, minimal wallet funding.
- Phase 4 (competitive infra): Jito bundles, dynamic tip bidding (rule of
  thumb: start tips around 50% of expected profit, adjust from there based
  on how often bundles get accepted), possibly gRPC streaming and/or Rust
  for the hot path, if Phase 3 data justifies the investment.

## Non-goals (any phase, unless we explicitly revisit)
- No sandwich attacks or predatory strategies
- No cross-chain arbitrage
- No leverage
- No skipping a phase's exit criteria to rush to the next

## Documentation discipline
- docs/adr/ — Architecture Decision Records for every significant choice
  (framework, data source, commitment level, etc.), via the ADR skill
- docs/sessions/ — one dated log per work session: WHAT I BUILT / WHAT
  WORKS / WHAT'S LEFT / OPEN QUESTIONS OR BLOCKERS
- Read the latest session log and ADR index at the start of every session
