# Solana Arbitrage Bot — Project Brief

## Goal
Build a Solana atomic arbitrage bot as a staged learning project.
Detect price differences across DEXs, simulate every trade, log every
attempt. Start on devnet with zero real money.

## Core architectural decisions (locked)
- Language: TypeScript + @solana/web3.js
- RPC provider: Helius (free tier to start)
- Commitment level: "processed" for reads and confirmation
- Devnet vs mainnet is a CONFIG SWITCH via .env, never a code change
- EVERY transaction is simulated via simulateTransaction before any
  send; abort if simulation fails or shows non-profit
- Every attempt is logged: timestamp, detected gap, simulated result,
  submitted/aborted, and why

## Scope for v1 (devnet)
- DEXs: Raydium and Orca (constant-product AMM) to start
- Pair: SOL/USDC
- Method: polling on an interval first; architect so a gRPC streaming
  feed can replace polling later without a rewrite
- Atomic single-transaction arbitrage only (both legs in one tx)

## Non-goals for v1
- No real/mainnet execution until explicitly approved
- No Jito bundles / MEV tips yet (mainnet phase only)
- No sandwich strategies, no cross-chain

## Later phases (do NOT build yet, just don't architect them out)
- Phase 2: read real mainnet pool state via Yellowstone gRPC, run in
  SHADOW MODE (detect + simulate + log, no sends)
- Phase 3: small-capital live mainnet with tight guardrails
- Phase 4: Jito bundles + dynamic tip bidding

## Secrets
- Helius API key and wallet key live in .env, never committed to git
- .env is in .gitignore from commit 1
