# ADR-0008: Structural send-disable for mainnet shadow mode

**Date**: 2026-07-17
**Status**: accepted
**Deciders**: Bhavish Goyal (project owner); designed via superpowers:brainstorming
on 2026-07-17, all six design decision points explicitly answered by the
owner before implementation (see
`docs/superpowers/specs/2026-07-17-phase-2-mainnet-shadow-mode-design.md`)

## Context

Phase 2 runs detection against REAL mainnet pool state but must NEVER
submit a real transaction (PROJECT_BRIEF phased roadmap; phase doc). The
owner's instruction was explicit: make this **structurally enforced**,
like the Phase-1 mainnet guard, "not just a policy you follow by
convention." A single `if` statement someone can refactor away is a
policy; independent layers that each refuse are a structure.

## Decision

Four barriers, each independent of the others:

1. **Config derivation (`src/config.ts`).** `Config.sendEnabled` is
   COMPUTED (`phase < 2`), never read from the environment. `PHASE=2` →
   always false, devnet or mainnet. Two refusals harden it:
   - `PHASE>=3` → `loadConfig` throws: live sending **does not exist in
     this version of the codebase**. Enabling it later requires a code
     change plus a new ADR — the same posture as the Phase-1 mainnet guard.
   - Any `SEND_ENABLED` env var → `loadConfig` throws ("no such switch
     exists"), a tripwire against the obvious future "just add a flag"
     bypass.
2. **Executor-internal refusal (`src/executor.ts`).** `execute()` takes
   `sendEnabled` in its meta and, after the mandatory simulation and CU
   measurement, returns a `"shadow-simulated"` record without
   `sendRawTransaction` ever being reachable. The gate module itself
   refuses; no caller wiring can change that.
3. **Null send transport (`src/main.ts`).** In shadow mode the RPC object
   handed to the executor gets a `sendRawTransaction` that throws
   `SendDisabledError` — the real capability is never constructed. If it
   ever throws, layer 2 was bypassed: loud crash, never a silent send.
4. **Unsigned transactions (incidental, `src/txbuilder/index.ts`).**
   Shadow builds use a surrogate-owner `PublicKey` payer (ADR-0009
   context), so the built transaction carries all-zero signatures and is
   unsubmittable even if a send were somehow attempted.

A startup banner announces shadow mode. Unit tests pin layers 1, 2, and 4
(config throw cases; a send-spy proving no call even for a profitable,
simulation-passing opportunity; zero-signature assertion).

## Alternatives considered

- **Executor flag only** — simplest, but one refactor away from gone.
- **Null transport only** — structural, but refusals would log as
  `send-failed`, polluting the revert-rate metric this phase exists to
  measure, and a wiring change could silently restore the capability.
- **Layered (chosen)** — all of the above must fail simultaneously.

## Consequences

- Phase 3 cannot begin by flipping config: it requires deliberate code
  changes (remove the `PHASE>=3` refusal, define what enables sending)
  plus an ADR. This is intentional friction.
- `SEND_ENABLED` is permanently rejected as a config key.
- Every shadow opportunity still runs the full mandatory-simulation gate
  (ADR-0005), so the logged `aborted-simulation-failed` rate remains an
  honest revert-rate signal.
