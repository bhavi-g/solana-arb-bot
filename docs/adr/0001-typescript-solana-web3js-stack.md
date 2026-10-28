# ADR-0001: TypeScript + @solana/web3.js as the stack

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md); drafted by Claude during the 2026-07-16 unattended session per owner's standing instruction

## Context

Phase 1 is a correctness-first learning phase on devnet with no money at risk. The dominant cost right now is developer iteration time and the risk of subtle logic bugs (AMM math, transaction construction), not latency. The Solana ecosystem's SDK depth — DEX SDKs (Orca Whirlpools, Raydium), Helius tooling, and examples — is strongest in TypeScript.

## Decision

We use TypeScript with @solana/web3.js for all Phase 1–3 code. Rust is deferred until a later phase *proves with measured data* that language-level latency is the bottleneck.

## Alternatives Considered

### Alternative 1: Rust from day one
- **Pros**: Best possible latency; the language serious competitive bots use; no future rewrite of the hot path.
- **Cons**: Much slower iteration for a learning project; DEX integration examples are sparser; latency is irrelevant in Phase 1–2 where we poll a free-tier RPC (the RPC round-trip dwarfs any language overhead by orders of magnitude).
- **Why not**: Optimizing the wrong bottleneck. Phase 1's failure mode is wrong math or unsafe execution logic, not slow code. Rust remains the planned escape hatch if Phase 3 data justifies it.

### Alternative 2: Python (solana-py)
- **Pros**: Fastest prototyping; familiar data-analysis ecosystem for studying logged opportunities.
- **Cons**: Weakest Solana SDK ecosystem; no first-class DEX SDKs (Whirlpools/Raydium are TS-first); no type safety on transaction construction where silent shape errors are costly; worst latency ceiling if code survives to later phases.
- **Why not**: The DEX SDK gap alone would force reimplementing pool-account decoding by hand, which is exactly where correctness bugs hide.

## Consequences

### Positive
- Direct access to Orca/Raydium/Helius official SDKs and the majority of community examples.
- Static types catch instruction/account-shape mistakes at compile time.
- One language across scanner, detector, builder, and tests.

### Negative
- If Phase 4 demands sub-millisecond internal processing, the hot path needs a Rust rewrite (accepted and planned for; the clean module boundaries required by ADR-0006 limit the blast radius).
- Node's GC can add occasional pause jitter — irrelevant now, measurable later.

### Risks
- Risk: SDK churn (e.g., web3.js v1 → v2 migration) breaks builds. Mitigation: pin exact dependency versions in package.json and commit the lockfile.
