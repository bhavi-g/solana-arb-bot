# docs/NEVER_DO.md

- NEVER connect to mainnet in Phase 1. Devnet only.
- NEVER commit .env or any file containing a key, even accidentally.
- NEVER submit a real transaction without simulateTransaction passing first.
- NEVER weaken or remove the min-profit threshold check to "make it work."
- NEVER invent/mock a successful trade result — log real simulation output only.
- If blocked or genuinely unsure, STOP and write the question into the
  session log under BLOCKERS rather than guessing and proceeding.
  