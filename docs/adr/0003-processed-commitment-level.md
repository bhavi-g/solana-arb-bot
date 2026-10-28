# ADR-0003: "processed" commitment level for all reads and confirmations

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md)

## Context

Solana offers three commitment levels: "processed" (seen by the connected node, ~0 extra wait), "confirmed" (voted on by a supermajority, typically +400–800ms), and "finalized" (rooted, +several seconds). Arbitrage opportunities on AMMs exist precisely because quotes are momentarily stale — data freshness is the entire edge. Meanwhile, the trade itself is atomic: if pool state changed and the numbers no longer work, the transaction reverts on-chain and we lose only the fee.

## Decision

We use "processed" commitment for every read (pool account fetches) and for transaction confirmation tracking, set once in the shared Connection configuration.

## Alternatives Considered

### Alternative 1: "confirmed" everywhere
- **Pros**: Practically no risk of acting on data from a minority fork; the common default in tutorials.
- **Cons**: Adds ~0.5s staleness to every price read. A price gap that is still visible at "confirmed" is a gap every slower competitor also sees; we'd systematically detect opportunities after they're gone.
- **Why not**: It buys safety we don't need. The failure "acted on forked/stale data" costs one reverted transaction fee (~5000 lamports); paying half a second on every read to avoid that is a terrible trade for an atomic strategy.

### Alternative 2: Mixed — "processed" reads, "confirmed" confirmations
- **Pros**: Fresh detection data, higher certainty when reporting a landed trade.
- **Cons**: Two commitment configs to keep straight; confirmation latency still delays the next decision cycle; the log can be reconciled after the fact anyway.
- **Why not**: Complexity without a safety gain — whether we *report* success at processed or confirmed doesn't change what happened on-chain, and post-hoc log reconciliation (Phase 2+) can verify landed status at finalized.

## Consequences

### Positive
- Freshest possible view of pool state on every poll — directly serves the strategy's core mechanism.
- One consistent setting; no per-call commitment reasoning.

### Negative
- A "processed" read can occasionally reflect a slot that never confirms; detection may fire on phantom state. The simulate-then-send gate (ADR-0005) and atomic revert make the worst case a lost fee, not a lost position.
- Success/failure logged at "processed" is provisional; definitive accounting should re-check at higher commitment offline.

### Risks
- Risk: systematically over-counting "successful" trades in logs due to processed-level optimism. Mitigation: log the commitment level with every attempt; Phase 2+ adds an offline reconciliation pass at finalized before any performance claims are trusted.
