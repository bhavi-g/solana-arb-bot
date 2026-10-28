# ADR-0002: Helius as RPC provider (config-swappable)

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md)

## Context

The bot needs a reliable RPC endpoint for devnet now and mainnet later. Public endpoints (api.devnet.solana.com) are heavily rate-limited and shed load unpredictably, which would make polling behavior hard to reason about. Helius's free tier offers 10 requests/second, devnet and mainnet endpoints under the same key, and a growth path (WebSockets on paid tiers, and its ecosystem is a common route to Yellowstone/Geyser gRPC later per the data-infrastructure roadmap).

## Decision

We use Helius as the RPC provider, with the URL supplied entirely via .env (RPC_URL / HELIUS_API_KEY). Nothing in code names Helius specifically; any RPC provider can be swapped in by editing .env. All polling is designed against a hard ceiling of 10 requests/second with backoff (see the rate limiter in the scanner).

## Alternatives Considered

### Alternative 1: Public Solana endpoints only
- **Pros**: Zero cost, zero signup.
- **Cons**: Aggressive, opaque rate limits; frequent 429s and dropped connections; no upgrade path to streaming.
- **Why not**: Unpredictable throttling would contaminate Phase 1's goal of learning what *our* code does; still useful as an emergency fallback since the provider is just a URL in .env.

### Alternative 2: QuickNode / Triton / Alchemy
- **Pros**: Comparable or better paid tiers; Triton in particular is strong for Yellowstone gRPC.
- **Cons**: Free tiers are credit-metered rather than a simple req/s budget, which is harder to design polling against; no meaningful advantage for Phase 1.
- **Why not**: No differentiator at this stage, and the .env-only coupling means switching later costs one config edit, not a refactor.

## Consequences

### Positive
- Deterministic budget to design around: the poll scheduler treats 10 req/s as a hard ceiling.
- Same provider covers devnet (Phase 1) and mainnet shadow mode (Phase 2) with only a config change.
- Clear upgrade path toward WebSocket and gRPC stages of the data roadmap.

### Negative
- 10 req/s caps how many pools / how frequently we can poll (fine for Phase 1's two pools; a real constraint for Phase 2 breadth).
- Free-tier reliability is not guaranteed; occasional throttling must be handled, not assumed away.

### Risks
- Risk: bursty polling exceeds 10 req/s and gets the key throttled. Mitigation: client-side token-bucket rate limiter below the ceiling plus exponential backoff on 429.
- Risk: provider lock-in creep (Helius-only SDK features). Mitigation: use plain JSON-RPC via @solana/web3.js Connection; no Helius-specific SDK calls in core modules.
