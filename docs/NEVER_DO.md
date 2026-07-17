# docs/NEVER_DO.md

- NEVER connect to mainnet in Phase 1. Devnet only.
- NEVER commit .env or any file containing a key, even accidentally.
- NEVER submit a real transaction without simulateTransaction passing first.
- NEVER weaken or remove the min-profit threshold check to "make it work."
- NEVER invent/mock a successful trade result — log real simulation output only.
- If blocked or genuinely unsure, STOP and write the question into the
  session log under BLOCKERS rather than guessing and proceeding.
- NEVER run third-party arbitrage bot code (GitHub repos, "MEV bot"
  services) with a funded wallet or real private key. Several documented
  cases exist of such repos stealing keys. Treat all external repos as
  reading material only, on a burner wallet, in isolation, if run at all.