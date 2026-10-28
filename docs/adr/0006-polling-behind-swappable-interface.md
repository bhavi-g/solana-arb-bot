# ADR-0006: Polling data source now, behind a swappable PriceSource interface

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md)

## Context

The data-infrastructure roadmap is staged: HTTP polling (now) → WebSocket subscriptions → Yellowstone/Geyser gRPC (sub-50ms, what competitive bots actually use). Polling on a 10 req/s free tier is definitively too slow to win real races — that is understood and accepted; Phase 1's goal is correct mechanics, not speed. The danger is architectural: if detection logic reaches directly into RPC calls, every data-source upgrade becomes a rewrite of the logic we've already validated.

## Decision

Detection consumes a `PriceSource` interface (async iterator / callback of timestamped `PoolSnapshot`s containing raw pool state: reserves for CPMM, sqrtPrice+liquidity for Whirlpool). The polling implementation — including the 10 req/s token-bucket rate limiter and backoff — lives entirely behind that interface. WebSocket or gRPC implementations later implement the same interface; detection, execution, and logging never change.

## Alternatives Considered

### Alternative 1: Direct RPC calls inside detection logic
- **Pros**: Fewer files; marginally faster to write day one.
- **Cons**: Data-source upgrades (the *planned* roadmap, not a hypothetical) each force a rewrite-and-revalidate of detection math; impossible to unit-test detection without a network.
- **Why not**: We know with certainty the data source will change twice. Coupling to it is borrowing against a known future.

### Alternative 2: Jump straight to WebSocket subscriptions
- **Pros**: Fresher data; skips one migration.
- **Cons**: Helius free-tier WebSocket support is limited/unreliable for this use; subscription lifecycle (reconnects, missed updates, account-notification decoding) adds failure modes that would tangle Phase 1 debugging; the brief explicitly says do not skip stages.
- **Why not**: Phase 1's enemy is confusion, not staleness. Polling is trivially debuggable — you see every request. The interface boundary means WebSocket lands later as a new adapter, not a rewrite.

### Alternative 3: Interface emits computed prices instead of raw pool state
- **Pros**: Thinner interface.
- **Cons**: Detection needs raw reserves/liquidity to compute *price impact* of a concrete trade size, not just marginal price; hiding raw state would force that math into the source adapter, splitting AMM math across two modules.
- **Why not**: Snapshots of raw state keep all math in one tested place and let future sources stay dumb pipes.

## Consequences

### Positive
- Detection math is pure and unit-testable with synthetic snapshots (exactly what Phase 1's TDD requirement needs).
- Data-source roadmap (poll → WS → gRPC) becomes three adapters against one contract.
- Rate limiting is an implementation detail of the polling adapter, invisible to consumers.

### Negative
- Polling at ≤10 req/s means multi-hundred-ms-stale prices; Phase 1 will "detect" opportunities that are long gone. Accepted: Phase 1 validates mechanics, and Phase 2 shadow mode is where detection quality gets measured.
- One extra abstraction layer to maintain (small: one interface, one adapter today).

### Risks
- Risk: interface leaks polling-specific assumptions (e.g., pull semantics) that don't fit push-based gRPC later. Mitigation: interface is push-shaped (subscribe/callback with snapshots) even though today's adapter fills it by polling internally.
