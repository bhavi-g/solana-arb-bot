# ADR-0004: Devnet/mainnet is a config switch, never a code fork

**Date**: 2026-07-16
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner, locked in PROJECT_BRIEF.md)

## Context

The project moves through phases: devnet mechanics → mainnet shadow mode → live mainnet. If devnet and mainnet were separate code paths (branches, duplicated modules, if-devnet blocks), then everything proven in Phase 1 would be *unproven* the moment we switch — the mainnet path would be new, untested code exactly when money enters the picture. NEVER_DO.md separately forbids touching mainnet during Phase 1 at all.

## Decision

Cluster selection lives entirely in .env (CLUSTER, RPC_URL, pool addresses, token mints). Code reads config and behaves identically regardless of cluster. Additionally, a phase guard in config validation refuses to start if CLUSTER is mainnet while the configured PHASE is 1 — a *validation rule on config*, not a forked code path.

## Alternatives Considered

### Alternative 1: Separate devnet/mainnet branches or modules
- **Pros**: Can hack devnet-only shortcuts without worrying about mainnet implications.
- **Cons**: Phase 1's testing proves nothing about the code that will eventually touch money; divergence grows silently; the "shortcut" habit is precisely what NEVER_DO.md exists to prevent.
- **Why not**: Defeats the entire staged-derisking premise of the project.

### Alternative 2: Pure config switch with no phase guard
- **Pros**: Simplest possible; zero cluster-awareness in code.
- **Cons**: One .env typo (or a copied mainnet URL) during Phase 1 would silently violate "NEVER connect to mainnet in Phase 1."
- **Why not**: The guard costs five lines of config validation and converts a NEVER_DO violation from "possible via typo" to "requires deliberately editing the phase declaration." Cheap insurance, and it validates data rather than forking behavior.

## Consequences

### Positive
- The code that runs on mainnet in later phases is the same code that was exercised on devnet.
- Environment differences (pool addresses, mints, RPC URL) are enumerated in one visible place: .env.
- Phase guard makes the NEVER_DO rule mechanically enforced, not just remembered.

### Negative
- Devnet quirks (shallow liquidity, test tokens) can't be special-cased in code; they must be absorbed by config choices (e.g., which pools to watch), which takes more care.
- The phase guard must be updated (PHASE=2 in .env) when Phase 2 legitimately begins — a small ceremony, by design.

### Risks
- Risk: config drift — .env.example falls out of sync with what code actually reads. Mitigation: config module validates all required keys at startup and fails loudly listing what's missing.
