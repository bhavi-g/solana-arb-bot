# Raydium CLMM ↔ Orca cross-DEX venue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the merged Raydium CLMM decoder + swap_v2 builder into a runnable `VENUE=clmm-orca` cross-DEX shadow venue (atomic two-leg arb tx, polling source, config/main wiring), proven by a read-only mainnet simulation smoke-check.

**Architecture:** Three new files, each a direct analog of an existing two-Orca-venue file, plus strictly-additive edits to `config.ts`/`main.ts`/`.env.example`. The CLMM leg calls the existing `buildClmmSwapV2Ix`; the Orca leg calls the existing `buildWhirlpoolSwapIx`; legs disambiguate by `dex` name (`raydium-clmm` vs `orca-whirlpool`), so no pool-address matching is needed. All existing venue paths (`cpmm-orca`, `orca-orca`, synthetic) stay untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@solana/web3.js`, vitest, `tsx`. Node crypto for Anchor discriminators (already in the swap_v2 builder).

**Spec:** `docs/superpowers/specs/2026-07-20-clmm-orca-venue-design.md`

## Global Constraints

- **ESM imports use `.js` specifiers** even for `.ts` files (e.g. `from "../src/types.js"`). Match the existing files exactly.
- **Isolation — additive only.** New files, plus additive edits to ONLY `src/config.ts`, `src/main.ts`, `.env.example`, and the existing `tests/config.test.ts`. Do NOT edit: `detect.ts`, `costs.ts`, `fee.ts`, `executor.ts`, `logger.ts`, `orcaOrcaPolling.ts`, `polling.ts`, `math/whirlpool.ts`, `txbuilder/index.ts`, `txbuilder/twoWhirlpool.ts`, `txbuilder/orcaWhirlpool.ts`, `txbuilder/raydiumClmm.ts`, `decode/clmm.ts`.
- **Base = SOL = pool `mint_0`** (orientation NORMAL, live-verified on pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`). The CLMM leg assumes and asserts this.
- **Shadow discipline (ADR-0008):** a `PublicKey` payer builds an UNSIGNED tx; the smoke-check calls ONLY `simulateTransaction` (`sigVerify:false`), never any send.
- **On-chain profit guard:** the sell leg's min-out = `quoteIn + minProfitThreshold`; the buy leg's min-out = `baseOut`.
- **Raydium CLMM mainnet program id:** `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` (distinct from the CPMM `raydiumProgramId`).
- **Run defaults:** CLMM pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`; Orca leg reuses the existing `ORCA_POOL_ADDRESS`.
- **Test/typecheck commands:** `npx vitest run <file>` for one file, `npm test` for the full suite, `npx tsc --noEmit` for typecheck.

---

### Task 1: `buildClmmOrcaArbTransaction` — atomic CLMM + Orca arb tx

**Files:**
- Create: `src/txbuilder/clmmOrca.ts`
- Test: `tests/clmmOrca.test.ts`

**Interfaces:**
- Consumes: `buildClmmSwapV2Ix` from `./raydiumClmm.js` (params include `programId, payer, ammConfig, poolState, inputTokenAccount, outputTokenAccount, inputVault, outputVault, observationState, inputVaultMint, outputVaultMint, tickCurrentIndex, tickSpacing, amount, otherAmountThreshold, inputIsToken0`); `buildWhirlpoolSwapIx` from `./orcaWhirlpool.js`; `associatedTokenAddress`, `TOKEN_PROGRAM_ID` from `./index.js`; `ClmmPoolState` from `../decode/clmm.js`; `WhirlpoolState` from `../decode/orcaWhirlpool.js`; `Opportunity`, `PairInfo` from `../types.js`.
- Produces:
  ```ts
  export interface ClmmOrcaBuildContext {
    payer: Keypair | PublicKey;
    recentBlockhash: string;
    pair: PairInfo;
    clmm: {
      programId: PublicKey;
      poolAddress: PublicKey;
      state: ClmmPoolState;
      tickCurrentIndex: number; // fresh from snapshot
    };
    whirlpool: {
      programId: PublicKey;
      poolAddress: PublicKey;
      state: WhirlpoolState;
      tickCurrentIndex: number; // fresh from snapshot
    };
  }
  export function buildClmmOrcaArbTransaction(
    ctx: ClmmOrcaBuildContext,
    opp: Opportunity,
    computeUnitLimit?: number,
  ): VersionedTransaction
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/clmmOrca.test.ts`:

```ts
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "../src/txbuilder/clmmOrca.js";
import type { ClmmPoolState } from "../src/decode/clmm.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { Opportunity } from "../src/types.js";

const kp = () => Keypair.generate().publicKey;
const baseMint = kp(); // SOL  = mint0 / whirlpool A
const quoteMint = kp(); // USDC = mint1 / whirlpool B
const clmmPool = kp();
const orcaPool = kp();
const clmmProgram = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const orcaProgram = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const clmmVault0 = kp(); // SOL vault
const clmmVault1 = kp(); // USDC vault

function clmmState(): ClmmPoolState {
  return {
    ammConfig: kp(),
    tokenMint0: baseMint,
    tokenMint1: quoteMint,
    tokenVault0: clmmVault0,
    tokenVault1: clmmVault1,
    observationKey: kp(),
    mintDecimals0: 9,
    mintDecimals1: 6,
    tickSpacing: 4,
    liquidity: 10n ** 15n,
    sqrtPriceX64: 7_144_247_248_808_263_680n,
    tickCurrentIndex: -25_696,
  };
}

function whirlState(): WhirlpoolState {
  return {
    sqrtPriceX64: 7_144_247_248_808_263_680n,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    tickSpacing: 64,
    feeBps: 4,
    tokenMintA: baseMint,
    tokenMintB: quoteMint,
    tokenVaultA: kp(),
    tokenVaultB: kp(),
  };
}

function ctx(payer: Keypair | PublicKey): ClmmOrcaBuildContext {
  return {
    payer,
    recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    pair: {
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseDecimals: 9,
      quoteDecimals: 6,
    },
    clmm: { programId: clmmProgram, poolAddress: clmmPool, state: clmmState(), tickCurrentIndex: -25_696 },
    whirlpool: { programId: orcaProgram, poolAddress: orcaPool, state: whirlState(), tickCurrentIndex: -18_975 },
  };
}

// Buy SOL on CLMM, sell on Orca.
const buyOnClmm: Opportunity = {
  decision: "opportunity",
  direction: { buyOn: "raydium-clmm", sellOn: "orca-whirlpool" },
  gapBps: -300,
  quoteIn: 100_000_000n,
  baseOut: 680_000_000n,
  quoteOut: 100_250_000n,
  estNetProfit: 250_000n,
  minProfitThreshold: 10_000n,
};

// CLMM swap_v2 ix layout: pool_state = account index 2, input_vault = index 5;
// data: amount@8, otherAmountThreshold@16 (both u64 LE).
// Whirlpool swap ix: whirlpool = account index 2; data: amount@8, threshold@16,
// aToB byte @41.
describe("buildClmmOrcaArbTransaction", () => {
  it("buy on CLMM / sell on Orca: CLMM leg inputs USDC (vault1), Orca leg sells SOL (aToB=true)", () => {
    const payer = Keypair.generate();
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, buyOnClmm);
    expect(tx.message.compiledInstructions.length).toBe(2);

    const keys = tx.message.staticAccountKeys;
    const clmm = tx.message.compiledInstructions[0]!; // buy leg first
    const orca = tx.message.compiledInstructions[1]!;

    // CLMM leg is on the CLMM pool, buying SOL → input is USDC (mint1) → input_vault = vault1
    expect(keys[clmm.accountKeyIndexes[2]!]!.equals(clmmPool)).toBe(true);
    expect(keys[clmm.accountKeyIndexes[5]!]!.equals(clmmVault1)).toBe(true);
    const clmmData = Buffer.from(clmm.data);
    expect(clmmData.readBigUInt64LE(8)).toBe(100_000_000n); // amount = quoteIn (USDC)
    expect(clmmData.readBigUInt64LE(16)).toBe(680_000_000n); // min SOL out = baseOut

    // Orca leg sells SOL → aToB = true, amount = baseOut, min out = quoteIn + threshold
    expect(keys[orca.accountKeyIndexes[2]!]!.equals(orcaPool)).toBe(true);
    const orcaData = Buffer.from(orca.data);
    expect(orcaData.readBigUInt64LE(8)).toBe(680_000_000n);
    expect(orcaData.readBigUInt64LE(16)).toBe(100_010_000n);
    expect(orcaData.readUInt8(41)).toBe(1); // aToB true

    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true); // signed
  });

  it("buy on Orca / sell on CLMM: Orca leg buys SOL (aToB=false), CLMM leg inputs SOL (vault0)", () => {
    const payer = Keypair.generate();
    const reversed: Opportunity = {
      ...buyOnClmm,
      direction: { buyOn: "orca-whirlpool", sellOn: "raydium-clmm" },
    };
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, reversed);

    const keys = tx.message.staticAccountKeys;
    const orca = tx.message.compiledInstructions[0]!; // buy leg first
    const clmm = tx.message.compiledInstructions[1]!;

    // Orca leg buys SOL → aToB = false, amount = quoteIn, min out = baseOut
    const orcaData = Buffer.from(orca.data);
    expect(orcaData.readBigUInt64LE(8)).toBe(100_000_000n);
    expect(orcaData.readBigUInt64LE(16)).toBe(680_000_000n);
    expect(orcaData.readUInt8(41)).toBe(0); // aToB false

    // CLMM leg sells SOL → input is SOL (mint0) → input_vault = vault0,
    // amount = baseOut, min out = quoteIn + threshold
    expect(keys[clmm.accountKeyIndexes[5]!]!.equals(clmmVault0)).toBe(true);
    const clmmData = Buffer.from(clmm.data);
    expect(clmmData.readBigUInt64LE(8)).toBe(680_000_000n);
    expect(clmmData.readBigUInt64LE(16)).toBe(100_010_000n);
  });

  it("prepends a compute-budget instruction when a CU limit is given", () => {
    const payer = Keypair.generate();
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, buyOnClmm, 240_000);
    expect(tx.message.compiledInstructions.length).toBe(3);
    const progIdx = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(tx.message.staticAccountKeys[progIdx]!.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
  });

  it("shares one SOL ATA and one USDC ATA across both legs", () => {
    const surrogate = kp();
    const tx = buildClmmOrcaArbTransaction(ctx(surrogate), buyOnClmm);
    const keys = tx.message.staticAccountKeys;
    const clmm = tx.message.compiledInstructions[0]!;
    const orca = tx.message.compiledInstructions[1]!;
    // CLMM output_token_account (index 4) is the SOL ATA (buying SOL);
    // Orca tokenOwnerAccountA (index 3) is the SOL ATA (selling SOL).
    // They must be the same derived account.
    expect(
      keys[clmm.accountKeyIndexes[4]!]!.equals(keys[orca.accountKeyIndexes[3]!]!),
    ).toBe(true);
  });

  it("builds UNSIGNED with a PublicKey payer (shadow-mode surrogate)", () => {
    const surrogate = kp();
    const tx = buildClmmOrcaArbTransaction(ctx(surrogate), buyOnClmm);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(surrogate)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/clmmOrca.test.ts`
Expected: FAIL — cannot resolve `../src/txbuilder/clmmOrca.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/txbuilder/clmmOrca.ts`:

```ts
/**
 * Assembles ONE atomic transaction with BOTH arbitrage legs across two
 * DEXes: a Raydium CLMM swap_v2 leg and an Orca Whirlpool swap leg
 * (Phase-2 clmm-orca cross-DEX shadow venue). Buy base (SOL) cheap on one
 * venue, sell it on the other, in a single tx; the sell leg's minimum out
 * (quoteIn + minProfitThreshold) enforces profitability on-chain, and the
 * mandatory simulation catches an unprofitable trade before any send.
 *
 * The CLMM pool is SOL(mint0)/USDC(mint1) and the whirlpool is
 * SOL(A)/USDC(B), so both legs share the owner's SOL and USDC ATAs. The
 * legs disambiguate by DEX name — direction.buyOn/sellOn are
 * "raydium-clmm" vs "orca-whirlpool", which differ — so no pool-address
 * matching is needed (unlike the two-Orca builder).
 *
 * Structural analog of buildArbTransaction in ./index.ts (the CPMM-vs-Orca
 * builder): the CPMM leg is swapped for a CLMM leg; the direction mapping
 * is identical because SOL is token0 in both the CPMM and CLMM pools.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Opportunity, PairInfo } from "../types.js";
import type { ClmmPoolState } from "../decode/clmm.js";
import type { WhirlpoolState } from "../decode/orcaWhirlpool.js";
import { buildClmmSwapV2Ix } from "./raydiumClmm.js";
import { buildWhirlpoolSwapIx } from "./orcaWhirlpool.js";
import { associatedTokenAddress, TOKEN_PROGRAM_ID } from "./index.js";

export interface ClmmLeg {
  programId: PublicKey;
  poolAddress: PublicKey;
  state: ClmmPoolState;
  /** Current tick from the freshest snapshot (moves every cycle). */
  tickCurrentIndex: number;
}

export interface WhirlpoolLeg {
  programId: PublicKey;
  poolAddress: PublicKey;
  state: WhirlpoolState;
  /** Current tick from the freshest snapshot (moves every cycle). */
  tickCurrentIndex: number;
}

export interface ClmmOrcaBuildContext {
  payer: Keypair | PublicKey;
  recentBlockhash: string;
  pair: PairInfo;
  clmm: ClmmLeg;
  whirlpool: WhirlpoolLeg;
}

export function buildClmmOrcaArbTransaction(
  ctx: ClmmOrcaBuildContext,
  opp: Opportunity,
  computeUnitLimit?: number,
): VersionedTransaction {
  const owner = ctx.payer instanceof Keypair ? ctx.payer.publicKey : ctx.payer;
  const baseMint = new PublicKey(ctx.pair.baseMint);
  const quoteMint = new PublicKey(ctx.pair.quoteMint);
  const baseAta = associatedTokenAddress(owner, baseMint); // SOL
  const quoteAta = associatedTokenAddress(owner, quoteMint); // USDC

  const minQuoteOut = opp.quoteIn + opp.minProfitThreshold;
  const buyLegIsClmm = opp.direction.buyOn === "raydium-clmm";

  const clmmIx = buildClmmLeg(
    ctx,
    owner,
    baseAta,
    quoteAta,
    buyLegIsClmm
      ? { inputIsQuote: true, amount: opp.quoteIn, threshold: opp.baseOut }
      : { inputIsQuote: false, amount: opp.baseOut, threshold: minQuoteOut },
  );
  const whirlIx = buildWhirlpoolLeg(
    ctx,
    owner,
    baseAta,
    quoteAta,
    buyLegIsClmm
      ? { aToB: true, amount: opp.baseOut, threshold: minQuoteOut }
      : { aToB: false, amount: opp.quoteIn, threshold: opp.baseOut },
  );

  const legs = buyLegIsClmm ? [clmmIx, whirlIx] : [whirlIx, clmmIx];
  const instructions: TransactionInstruction[] =
    computeUnitLimit !== undefined
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }), ...legs]
      : legs;

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: ctx.recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (ctx.payer instanceof Keypair) tx.sign([ctx.payer]);
  return tx;
}

function buildClmmLeg(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  leg: { inputIsQuote: boolean; amount: bigint; threshold: bigint },
): TransactionInstruction {
  const s = ctx.clmm.state;
  if (
    s.tokenMint0.toBase58() !== ctx.pair.baseMint ||
    s.tokenMint1.toBase58() !== ctx.pair.quoteMint
  ) {
    throw new Error(
      "CLMM pool orientation mismatch: expected base=mint0 / quote=mint1",
    );
  }
  // base (SOL) is token0, so quote-in means input is NOT token0.
  const inputIsToken0 = !leg.inputIsQuote;
  const inputVault = inputIsToken0 ? s.tokenVault0 : s.tokenVault1;
  const outputVault = inputIsToken0 ? s.tokenVault1 : s.tokenVault0;
  const inputMint = inputIsToken0 ? s.tokenMint0 : s.tokenMint1;
  const outputMint = inputIsToken0 ? s.tokenMint1 : s.tokenMint0;
  const inputTokenAccount = inputIsToken0 ? baseAta : quoteAta;
  const outputTokenAccount = inputIsToken0 ? quoteAta : baseAta;

  return buildClmmSwapV2Ix({
    programId: ctx.clmm.programId,
    payer: owner,
    ammConfig: s.ammConfig,
    poolState: ctx.clmm.poolAddress,
    inputTokenAccount,
    outputTokenAccount,
    inputVault,
    outputVault,
    observationState: s.observationKey,
    inputVaultMint: inputMint,
    outputVaultMint: outputMint,
    tickCurrentIndex: ctx.clmm.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: leg.amount,
    otherAmountThreshold: leg.threshold,
    inputIsToken0,
  });
}

function buildWhirlpoolLeg(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  leg: { aToB: boolean; amount: bigint; threshold: bigint },
): TransactionInstruction {
  const s = ctx.whirlpool.state;
  return buildWhirlpoolSwapIx({
    programId: ctx.whirlpool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: ctx.whirlpool.poolAddress,
    tokenOwnerAccountA: baseAta,
    tokenVaultA: s.tokenVaultA,
    tokenOwnerAccountB: quoteAta,
    tokenVaultB: s.tokenVaultB,
    tickCurrentIndex: ctx.whirlpool.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: leg.amount,
    otherAmountThreshold: leg.threshold,
    aToB: leg.aToB,
  });
}
```

**Note on `inputIsToken0 = !leg.inputIsQuote`:** this is the `inputIsQuote ? !baseIsToken0 : baseIsToken0` formula from `index.ts`'s `buildCpmmLeg` specialized to `baseIsToken0 = true` (SOL is `mint_0`), which the orientation guard above enforces.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/clmmOrca.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify the test's hard-coded account indices against the real builders**

The tests hard-code account indices and data offsets that must match the
already-merged, live-verified builders (which are the source of truth — do
NOT edit them). Read both and confirm, adjusting only the TEST indices if
any differ:
- `src/txbuilder/orcaWhirlpool.ts` (`buildWhirlpoolSwapIx`): the whirlpool
  account index (test uses **2**), `tokenOwnerAccountA` index (the
  shared-ATA test uses **3**), and the `aToB` data byte offset (test uses
  **41**).
- `src/txbuilder/raydiumClmm.ts` (`buildClmmSwapV2Ix`): `poolState` index
  (**2**), `outputTokenAccount` index (**4**), `inputVault` index (**5**),
  and the `amount`/`otherAmountThreshold` data offsets (**8**/**16**).
These match the merged builders at authoring time; verify they still hold.
Re-run Step 4 after any test-index adjustment.

- [ ] **Step 6: Commit**

```bash
git add src/txbuilder/clmmOrca.ts tests/clmmOrca.test.ts
git commit -m "feat: buildClmmOrcaArbTransaction — atomic CLMM+Orca cross-DEX arb tx"
```

---

### Task 2: `ClmmOrcaPollingSource` — per-cycle CLMM+Orca snapshot source

**Files:**
- Create: `src/datasource/clmmOrcaPolling.ts`
- Test: `tests/clmmOrcaPolling.test.ts`

**Interfaces:**
- Consumes: `decodeClmmPool`, `toClmmSnapshot`, `ClmmPoolState`, `ClmmSnapshotMeta` from `../decode/clmm.js`; `decodeWhirlpool`, `WhirlpoolState` from `../decode/orcaWhirlpool.js`; `PriceSource`, `SnapshotHandler`, `SnapshotPair` from `./PriceSource.js`; `RateLimiter` from `./rateLimiter.js`; `PairInfo`, `PoolSnapshot` from `../types.js`.
- Produces:
  ```ts
  export interface ClmmOrcaConfig {
    clmmPoolAddress: string;
    whirlpoolAddress: string;
    pair: PairInfo;
    pollIntervalMs: number;
    clmmFeeBps: number; // resolved once at startup, injected here
  }
  export interface AccountBatchFetcher {
    getMultipleAccountsInfoAndContext(keys: PublicKey[]): Promise<{
      context: { slot: number };
      value: Array<{ data: Uint8Array } | null>;
    }>;
  }
  export type ClmmDecoder = (data: Uint8Array) => ClmmPoolState;
  export type WhirlpoolDecoder = (data: Uint8Array) => WhirlpoolState;
  export class ClmmOrcaPollingSource implements PriceSource {
    readonly name = "polling";
    constructor(
      fetcher: AccountBatchFetcher,
      cfg: ClmmOrcaConfig,
      limiter: RateLimiter,
      decodeClmm?: ClmmDecoder,
      decodeWhirl?: WhirlpoolDecoder,
    );
    run(onPair: SnapshotHandler): Promise<void>;
    stop(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/clmmOrcaPolling.test.ts`:

```ts
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ClmmOrcaPollingSource,
  type AccountBatchFetcher,
} from "../src/datasource/clmmOrcaPolling.js";
import { RateLimiter } from "../src/datasource/rateLimiter.js";
import type { ClmmPoolState } from "../src/decode/clmm.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";

const base = "So11111111111111111111111111111111111111112";
const quote = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const clmmAddr = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const orcaAddr = new PublicKey("FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q");
const pair = { baseMint: base, quoteMint: quote, baseDecimals: 9, quoteDecimals: 6 };

function clmm(mint0 = base, mint1 = quote): ClmmPoolState {
  return {
    ammConfig: new PublicKey(clmmAddr),
    tokenMint0: new PublicKey(mint0),
    tokenMint1: new PublicKey(mint1),
    tokenVault0: new PublicKey(clmmAddr),
    tokenVault1: new PublicKey(orcaAddr),
    observationKey: new PublicKey(clmmAddr),
    mintDecimals0: 9,
    mintDecimals1: 6,
    tickSpacing: 4,
    liquidity: 10n ** 15n,
    sqrtPriceX64: 7n,
    tickCurrentIndex: -25_696,
  };
}

function whirl(mintA = base, mintB = quote): WhirlpoolState {
  return {
    sqrtPriceX64: 9n,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    tickSpacing: 64,
    feeBps: 30,
    tokenMintA: new PublicKey(mintA),
    tokenMintB: new PublicKey(mintB),
    tokenVaultA: new PublicKey(clmmAddr),
    tokenVaultB: new PublicKey(orcaAddr),
  };
}

class FakeFetcher implements AccountBatchFetcher {
  calls = 0;
  constructor(
    private readonly slot: number,
    private readonly value: Array<{ data: Uint8Array } | null>,
    private readonly onCall?: () => void,
  ) {}
  async getMultipleAccountsInfoAndContext(_keys: PublicKey[]) {
    this.calls++;
    this.onCall?.();
    return { context: { slot: this.slot }, value: this.value };
  }
}

// Injected decoders: byte 0 → CLMM state, byte 1 → whirlpool state.
const decodeClmm = (_d: Uint8Array): ClmmPoolState => clmm();
const decodeWhirl = (_d: Uint8Array): WhirlpoolState => whirl();

function make(
  fetcher: AccountBatchFetcher,
  clmmFeeBps = 4,
  dc = decodeClmm,
  dw = decodeWhirl,
) {
  return new ClmmOrcaPollingSource(
    fetcher,
    { clmmPoolAddress: clmmAddr.toBase58(), whirlpoolAddress: orcaAddr.toBase58(), pair, pollIntervalMs: 0, clmmFeeBps },
    new RateLimiter(10),
    dc,
    dw,
  );
}

describe("ClmmOrcaPollingSource", () => {
  it("emits one SnapshotPair per cycle: CLMM in cpmm slot (injected feeBps), Orca in whirlpool slot", async () => {
    const fetcher = new FakeFetcher(555, [{ data: new Uint8Array([0]) }, { data: new Uint8Array([1]) }]);
    const source = make(fetcher, 4);
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
      source.stop();
    });
    expect(pairs.length).toBe(1);
    const p = pairs[0]!;
    expect(p.cpmm.kind).toBe("whirlpool");
    expect(p.cpmm.dex).toBe("raydium-clmm");
    expect(p.cpmm.poolAddress).toBe(clmmAddr.toBase58());
    expect(p.cpmm.feeBps).toBe(4);
    expect(p.whirlpool.kind).toBe("whirlpool");
    expect(p.whirlpool.dex).toBe("orca-whirlpool");
    expect(p.whirlpool.poolAddress).toBe(orcaAddr.toBase58());
    expect(p.cpmm.slot).toBe(555);
    if (p.cpmm.kind === "whirlpool") expect(p.cpmm.sqrtPriceX64).toBe(7n);
    if (p.whirlpool.kind === "whirlpool") expect(p.whirlpool.sqrtPriceX64).toBe(9n);
  });

  it("does not emit a pair when an account is missing (throws, caught by the loop)", async () => {
    let source!: ClmmOrcaPollingSource;
    const fetcher = new FakeFetcher(1, [null, { data: new Uint8Array([1]) }], () => source.stop());
    source = make(fetcher);
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
    });
    expect(fetcher.calls).toBe(1);
    expect(pairs.length).toBe(0);
  });

  it("rejects a CLMM pool whose orientation is not base=mint0 / quote=mint1", async () => {
    let source!: ClmmOrcaPollingSource;
    const fetcher = new FakeFetcher(1, [{ data: new Uint8Array([0]) }, { data: new Uint8Array([1]) }], () => source.stop());
    source = make(fetcher, 4, (_d) => clmm(quote, base)); // mint0=quote, mint1=base → bad
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
    });
    expect(fetcher.calls).toBe(1);
    expect(pairs.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/clmmOrcaPolling.test.ts`
Expected: FAIL — cannot resolve `../src/datasource/clmmOrcaPolling.js`.

- [ ] **Step 3: Write the implementation**

Create `src/datasource/clmmOrcaPolling.ts`:

```ts
/**
 * ClmmOrcaPollingSource: polls one Raydium CLMM pool and one Orca
 * whirlpool (same SOL/USDC pair) per cycle and emits a SnapshotPair
 * (ADR-0006). Phase-2 clmm-orca cross-DEX shadow venue — the venue that
 * can finally produce a real go/no-go signal (the two-Orca interim could
 * not; see docs/phases/phase-2-mainnet-shadow-mode.md).
 *
 * The SnapshotPair slots are cosmetic (as in orcaOrcaPolling.ts): the CLMM
 * fills the `cpmm` slot, the whirlpool fills the `whirlpool` slot;
 * detection/fee/cost math take a generic PoolSnapshot regardless of kind.
 *
 * CLMM's fee lives in the referenced AmmConfig, not the pool account, and
 * is effectively static — so it is resolved ONCE at startup (in main.ts's
 * setUpClmmOrca) and injected here as `clmmFeeBps`; this source never reads
 * the AmmConfig. One getMultipleAccounts per cycle (CLMM pool + whirlpool).
 */
import { PublicKey } from "@solana/web3.js";
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";
import { RateLimiter } from "./rateLimiter.js";
import {
  decodeClmmPool,
  toClmmSnapshot,
  type ClmmPoolState,
} from "../decode/clmm.js";
import { decodeWhirlpool, type WhirlpoolState } from "../decode/orcaWhirlpool.js";

export interface ClmmOrcaConfig {
  clmmPoolAddress: string;
  whirlpoolAddress: string;
  pair: PairInfo;
  pollIntervalMs: number;
  /** CLMM trade fee in bps, resolved once at startup from the AmmConfig. */
  clmmFeeBps: number;
}

/** Minimal RPC slice used here (real Connection satisfies it; fakeable). */
export interface AccountBatchFetcher {
  getMultipleAccountsInfoAndContext(
    keys: PublicKey[],
  ): Promise<{
    context: { slot: number };
    value: Array<{ data: Uint8Array } | null>;
  }>;
}

export type ClmmDecoder = (data: Uint8Array) => ClmmPoolState;
export type WhirlpoolDecoder = (data: Uint8Array) => WhirlpoolState;

export class ClmmOrcaPollingSource implements PriceSource {
  readonly name = "polling";
  private stopped = false;

  constructor(
    private readonly fetcher: AccountBatchFetcher,
    private readonly cfg: ClmmOrcaConfig,
    private readonly limiter: RateLimiter,
    private readonly decodeClmm: ClmmDecoder = decodeClmmPool,
    private readonly decodeWhirl: WhirlpoolDecoder = decodeWhirlpool,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    const clmm = new PublicKey(this.cfg.clmmPoolAddress);
    const orca = new PublicKey(this.cfg.whirlpoolAddress);

    while (!this.stopped) {
      const cycleStart = Date.now();
      try {
        await this.limiter.acquire();
        // Stamp acquisition-start BEFORE the RPC so handoffMs captures the
        // round-trip; both legs come from this one batch read.
        const fetchStartedAtMs = Date.now();
        const { context, value } =
          await this.fetcher.getMultipleAccountsInfoAndContext([clmm, orca]);
        this.limiter.notifySuccess();
        const [clmmAcc, orcaAcc] = value;
        if (!clmmAcc || !orcaAcc) {
          throw new Error("CLMM pool or whirlpool not found on this cluster");
        }
        const clmmSnap = toClmmSnapshot(
          this.decodeClmm(clmmAcc.data),
          this.cfg.clmmFeeBps,
          {
            poolAddress: clmm.toBase58(),
            pair: this.cfg.pair,
            slot: context.slot,
            source: this.name,
            fetchStartedAtMs,
          },
        );
        const pair: SnapshotPair = {
          cpmm: clmmSnap,
          whirlpool: this.orcaSnapshot(
            orca,
            this.decodeWhirl(orcaAcc.data),
            context.slot,
            fetchStartedAtMs,
          ),
        };
        await onPair(pair);
      } catch (e) {
        this.noteFailure(e);
      }
      const elapsed = Date.now() - cycleStart;
      const wait = Math.max(0, this.cfg.pollIntervalMs - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private orcaSnapshot(
    address: PublicKey,
    w: WhirlpoolState,
    slot: number,
    fetchStartedAtMs: number,
  ): PoolSnapshot {
    if (
      w.tokenMintA.toBase58() !== this.cfg.pair.baseMint ||
      w.tokenMintB.toBase58() !== this.cfg.pair.quoteMint
    ) {
      throw new Error(
        `Whirlpool ${address.toBase58()} orientation mismatch: expected ` +
          `A=${this.cfg.pair.baseMint} B=${this.cfg.pair.quoteMint}`,
      );
    }
    return {
      kind: "whirlpool",
      dex: "orca-whirlpool",
      poolAddress: address.toBase58(),
      pair: this.cfg.pair,
      fetchStartedAtMs,
      slot,
      source: this.name,
      sqrtPriceX64: w.sqrtPriceX64,
      liquidity: w.liquidity,
      tickCurrentIndex: w.tickCurrentIndex,
      feeBps: w.feeBps,
    };
  }

  private noteFailure(e: unknown): void {
    const msg = String(e);
    if (msg.includes("429") || msg.includes("-32429")) {
      this.limiter.notifyRateLimited();
      console.warn(`[polling] rate limited, backing off: ${msg}`);
    } else {
      console.warn(`[polling] cycle failed: ${msg}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/clmmOrcaPolling.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Confirm `RateLimiter` has `notifySuccess`/`notifyRateLimited`**

The code calls `this.limiter.notifySuccess()` and `this.limiter.notifyRateLimited()` — these are copied verbatim from `orcaOrcaPolling.ts`. Read `src/datasource/rateLimiter.js` to confirm both method names exist; if `orcaOrcaPolling.ts` compiles today they do. Re-run Step 4 if any name differs.

- [ ] **Step 6: Commit**

```bash
git add src/datasource/clmmOrcaPolling.ts tests/clmmOrcaPolling.test.ts
git commit -m "feat: ClmmOrcaPollingSource — per-cycle CLMM+Orca snapshot source"
```

---

### Task 3: `config.ts` — `clmm-orca` venue config + validation

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (add one `it` inside the existing `describe("sendEnabled derivation (ADR-0008 structural send-disable)")` block, next to the `VENUE=orca-orca` test)

**Interfaces:**
- Produces (additions to the `Config` interface): `venue: "cpmm-orca" | "orca-orca" | "clmm-orca"`; `raydiumClmmProgramId: string`; `clmmPoolAddress?: string`.

- [ ] **Step 1: Write the failing test**

In `tests/config.test.ts`, inside the `describe("sendEnabled derivation ...")` block (where `shadowEnv` is in scope), add after the `VENUE=orca-orca` test:

```ts
  it("VENUE=clmm-orca requires a CLMM pool + an Orca pool and defaults the CLMM program id", () => {
    const clmmOrca = (over: Record<string, string> = {}) =>
      shadowEnv({
        DATA_SOURCE: "polling",
        VENUE: "clmm-orca",
        BASE_MINT: "B",
        QUOTE_MINT: "Q",
        BASE_DECIMALS: "9",
        QUOTE_DECIMALS: "6",
        ...over,
      });
    // missing RAYDIUM_CLMM_POOL_ADDRESS → throws
    expect(() =>
      loadConfig(clmmOrca({ ORCA_POOL_ADDRESS: "O" })),
    ).toThrow(/RAYDIUM_CLMM_POOL_ADDRESS/);
    // both present → loads
    const cfg = loadConfig(
      clmmOrca({ RAYDIUM_CLMM_POOL_ADDRESS: "C", ORCA_POOL_ADDRESS: "O" }),
    );
    expect(cfg.venue).toBe("clmm-orca");
    expect(cfg.clmmPoolAddress).toBe("C");
    expect(cfg.orcaPoolAddress).toBe("O");
    expect(cfg.raydiumClmmProgramId).toBe(
      "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    );
    // override is honored
    expect(
      loadConfig(
        clmmOrca({ RAYDIUM_CLMM_POOL_ADDRESS: "C", ORCA_POOL_ADDRESS: "O", RAYDIUM_CLMM_PROGRAM_ID: "Custom111" }),
      ).raydiumClmmProgramId,
    ).toBe("Custom111");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `VENUE must be "cpmm-orca" or "orca-orca"` is thrown for `clmm-orca` (validation rejects the new value before the new keys are checked).

- [ ] **Step 3: Edit `src/config.ts` — the `Config` interface**

In the `Config` interface, change the `venue` union and add two fields. Find:

```ts
  venue: "cpmm-orca" | "orca-orca";
  orcaPoolAddressB?: string;
```

Replace with:

```ts
  venue: "cpmm-orca" | "orca-orca" | "clmm-orca";
  orcaPoolAddressB?: string;
  /** Raydium CLMM pool address (VENUE=clmm-orca). */
  clmmPoolAddress?: string;
```

Then, near `raydiumProgramId: string;`, add after it:

```ts
  raydiumProgramId: string;
  /**
   * Raydium CLMM program id (VENUE=clmm-orca) — a DISTINCT program from the
   * CPMM raydiumProgramId. Default mainnet CAMMCzo…; override with
   * RAYDIUM_CLMM_PROGRAM_ID.
   */
  raydiumClmmProgramId: string;
```

- [ ] **Step 4: Edit `src/config.ts` — the program-id constant**

After the `const ORCA_WHIRLPOOL_PROGRAM = ...` line, add:

```ts
// Raydium CLMM program (same address devnet/mainnet per docs.raydium.io).
const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
```

- [ ] **Step 5: Edit `src/config.ts` — venue validation + required keys**

Find:

```ts
  const venue = env.VENUE ?? "cpmm-orca";
  if (venue !== "cpmm-orca" && venue !== "orca-orca") {
    throw new ConfigError(
      `VENUE must be "cpmm-orca" or "orca-orca", got "${venue}"`,
    );
  }
```

Replace with:

```ts
  const venue = env.VENUE ?? "cpmm-orca";
  if (venue !== "cpmm-orca" && venue !== "orca-orca" && venue !== "clmm-orca") {
    throw new ConfigError(
      `VENUE must be "cpmm-orca", "orca-orca", or "clmm-orca", got "${venue}"`,
    );
  }
```

Then find the `venueKeys` block:

```ts
    const venueKeys =
      venue === "orca-orca"
        ? ["ORCA_POOL_ADDRESS", "ORCA_POOL_ADDRESS_B"]
        : ["RAYDIUM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"];
```

Replace with:

```ts
    const venueKeys =
      venue === "orca-orca"
        ? ["ORCA_POOL_ADDRESS", "ORCA_POOL_ADDRESS_B"]
        : venue === "clmm-orca"
          ? ["RAYDIUM_CLMM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"]
          : ["RAYDIUM_POOL_ADDRESS", "ORCA_POOL_ADDRESS"];
```

- [ ] **Step 6: Edit `src/config.ts` — the returned config object**

Find:

```ts
    orcaProgramId: env.ORCA_WHIRLPOOL_PROGRAM_ID ?? ORCA_WHIRLPOOL_PROGRAM,
```

Add immediately after it:

```ts
    raydiumClmmProgramId: env.RAYDIUM_CLMM_PROGRAM_ID ?? RAYDIUM_CLMM_PROGRAM,
```

Then find the `...(env.ORCA_POOL_ADDRESS_B ? ...)` spread and add after it:

```ts
    ...(env.RAYDIUM_CLMM_POOL_ADDRESS
      ? { clmmPoolAddress: env.RAYDIUM_CLMM_POOL_ADDRESS }
      : {}),
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (new test + all existing config tests still green).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: VENUE=clmm-orca config + validation (CLMM program id + pool)"
```

---

### Task 4: `main.ts` `setUpClmmOrca` + dispatch, and `.env.example`

**Files:**
- Modify: `src/main.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ClmmOrcaPollingSource`, `ClmmOrcaConfig` from `./datasource/clmmOrcaPolling.js`; `buildClmmOrcaArbTransaction`, `ClmmOrcaBuildContext` from `./txbuilder/clmmOrca.js`; `decodeClmmPool`, `decodeClmmAmmConfigFeeBps` from `./decode/clmm.js`; existing `setUp` helpers (`resolveStartupFeeLamports`, `sampleOpportunity`, `sampleSnapshotPair`, `BuildTx`, `Setup`).
- Produces: no exported symbols; `setUpClmmOrca` is a private helper wired into the `setUp` dispatch, exactly like `setUpOrcaOrca`.

*(No unit test — `main.ts` is the composition root, verified by typecheck + the full suite in this task and the mainnet smoke-check in Task 5, matching how the two-Orca wiring was verified.)*

- [ ] **Step 1: Add imports to `src/main.ts`**

After the existing `import { buildTwoWhirlpoolArbTransaction, type TwoWhirlpoolBuildContext } from "./txbuilder/twoWhirlpool.js";` block, add:

```ts
import { ClmmOrcaPollingSource } from "./datasource/clmmOrcaPolling.js";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "./txbuilder/clmmOrca.js";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "./decode/clmm.js";
```

- [ ] **Step 2: Add the dispatch branch in `setUp`**

In `setUp`, find the existing venue dispatch:

```ts
    if (cfg.venue === "orca-orca") {
      return setUpOrcaOrca(cfg, connection, limiter, buildPayer, orcaProgramId, pair);
    }
```

Add immediately after it:

```ts
    if (cfg.venue === "clmm-orca") {
      return setUpClmmOrca(cfg, connection, limiter, buildPayer, orcaProgramId, pair);
    }
```

- [ ] **Step 3: Add `setUpClmmOrca` after `setUpOrcaOrca`**

At the end of `src/main.ts`, after the `setUpOrcaOrca` function (before the final `main().catch(...)`), add:

```ts
/**
 * clmm-orca cross-DEX venue setup (Phase-2). Polls one Raydium CLMM pool +
 * one Orca whirlpool and builds atomic CLMM+Orca arb transactions. The CLMM
 * fee lives in the referenced AmmConfig (not the pool account) and is
 * effectively static, so it is resolved ONCE here at startup and injected
 * into the polling source. Geyser is not wired for this venue.
 */
async function setUpClmmOrca(
  cfg: Config,
  connection: Connection,
  limiter: RateLimiter,
  buildPayer: Keypair | PublicKey,
  orcaProgramId: PublicKey,
  pair: PairInfo,
): Promise<Setup> {
  if (cfg.dataSource === "geyser") {
    throw new Error(
      "VENUE=clmm-orca is only wired for DATA_SOURCE=polling (a heterogeneous " +
        "CLMM+Orca Geyser source is not implemented yet)",
    );
  }

  const clmmProgramId = new PublicKey(cfg.raydiumClmmProgramId);
  const clmmPool = new PublicKey(cfg.clmmPoolAddress!);
  const orcaPool = new PublicKey(cfg.orcaPoolAddress!);

  // Startup reads: CLMM pool (for static state) + Orca whirlpool.
  await limiter.acquire();
  const [clmmAcc, orcaAcc] = await connection.getMultipleAccountsInfo([
    clmmPool,
    orcaPool,
  ]);
  if (!clmmAcc || !orcaAcc) {
    throw new Error("configured clmm-orca pool accounts not found on this cluster");
  }
  const clmmState = decodeClmmPool(clmmAcc.data);
  const orcaState = decodeWhirlpool(orcaAcc.data);

  // CLMM fee lives in the referenced AmmConfig — read it once here.
  await limiter.acquire();
  const ammConfigAcc = await connection.getAccountInfo(clmmState.ammConfig);
  if (!ammConfigAcc) {
    throw new Error(`CLMM AmmConfig ${clmmState.ammConfig.toBase58()} not found`);
  }
  const clmmFeeBps = decodeClmmAmmConfigFeeBps(ammConfigAcc.data);

  const source = new ClmmOrcaPollingSource(
    connection,
    {
      clmmPoolAddress: clmmPool.toBase58(),
      whirlpoolAddress: orcaPool.toBase58(),
      pair,
      pollIntervalMs: cfg.pollIntervalMs,
      clmmFeeBps,
    },
    limiter,
  );

  const makeCtx = (
    snap: SnapshotPair,
    blockhash: string,
  ): ClmmOrcaBuildContext => ({
    payer: buildPayer,
    recentBlockhash: blockhash,
    pair,
    clmm: {
      programId: clmmProgramId,
      poolAddress: clmmPool,
      state: clmmState,
      tickCurrentIndex:
        snap.cpmm.kind === "whirlpool" ? snap.cpmm.tickCurrentIndex : clmmState.tickCurrentIndex,
    },
    whirlpool: {
      programId: orcaProgramId,
      poolAddress: orcaPool,
      state: orcaState,
      tickCurrentIndex:
        snap.whirlpool.kind === "whirlpool"
          ? snap.whirlpool.tickCurrentIndex
          : orcaState.tickCurrentIndex,
    },
  });
  const buildTx: BuildTx = (snap, blockhash, opp, cuLimit) =>
    buildClmmOrcaArbTransaction(makeCtx(snap, blockhash), opp, cuLimit);

  const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
    cfg,
    connection,
    limiter,
    (blockhash) =>
      buildTx(
        sampleSnapshotPair(pair, orcaState.tickCurrentIndex),
        blockhash,
        sampleOpportunity(cfg),
      ),
  );

  console.log(
    `[main] VENUE=clmm-orca: CLMM ${clmmPool.toBase58()} (fee ${clmmFeeBps}bps) vs ` +
      `Orca ${orcaPool.toBase58()} (fee ${orcaState.feeBps}bps)`,
  );
  return { source, buildTx, feeLamportsWithHeadroom };
}
```

**Note on the fee-sample opportunity:** `sampleOpportunity(cfg)` (no pool-address args) returns `buyOn:"raydium-cpmm"`/`sellOn:"orca-whirlpool"`. In `buildClmmOrcaArbTransaction`, `buyLegIsClmm = buyOn === "raydium-clmm"` is therefore `false` for the sample, so it shapes the "buy on Orca / sell on CLMM" tx — a valid, well-formed shape for the `getFeeForMessage` fee estimate (the estimate only needs a representative account list, not a specific direction). No change to `sampleOpportunity` is needed.

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms the new `setUpClmmOrca` types line up with `Setup`, `BuildTx`, `ClmmOrcaBuildContext`, and the config fields from Task 3.)

- [ ] **Step 5: Run the full test suite (regression)**

Run: `npm test`
Expected: all tests pass (the pre-existing suite plus Tasks 1–3's new tests). No existing test changes.

- [ ] **Step 6: Add a documented `clmm-orca` block to `.env.example`**

Append to `.env.example` (near the existing `VENUE`/`ORCA_POOL_ADDRESS` documentation):

```bash
# --- VENUE=clmm-orca (Raydium CLMM vs Orca Whirlpool, cross-DEX shadow) ---
# VENUE=clmm-orca
# RAYDIUM_CLMM_POOL_ADDRESS=3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv  # live-verified SOL/USDC CLMM, $5.9M TVL, 4bps
# ORCA_POOL_ADDRESS=<a SOL/USDC Orca whirlpool>   # reused for the Orca leg
# RAYDIUM_CLMM_PROGRAM_ID=CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK  # default; override only if needed
# (BASE_MINT/QUOTE_MINT/BASE_DECIMALS/QUOTE_DECIMALS as for the other venues)
```

- [ ] **Step 7: Commit**

```bash
git add src/main.ts .env.example
git commit -m "feat: wire VENUE=clmm-orca (setUpClmmOrca) + .env.example block"
```

---

### Task 5: Read-only mainnet sim smoke-check

**Files:**
- Create: `scripts/smoke-clmm-orca-arb-sim.ts`

**Interfaces:**
- Consumes: `buildClmmOrcaArbTransaction`, `ClmmOrcaBuildContext` from `../src/txbuilder/clmmOrca.js`; `decodeClmmPool`, `decodeClmmAmmConfigFeeBps` from `../src/decode/clmm.js`; `decodeWhirlpool` from `../src/decode/orcaWhirlpool.js`; `Opportunity` from `../src/types.js`.
- Produces: nothing (a runnable script; deliverable is its observed output).

**Pass criterion (honest — read before writing).** The atomic tx buys SOL
on one venue and sells it on the other. The builder hard-codes the sell
leg's min-out to `quoteIn + minProfitThreshold` (breakeven+), so a real
simulation returns `err:null` ONLY when a genuine cross-venue gap exists at
that instant; otherwise it returns a *slippage/amount-class* error. BOTH of
those outcomes prove the tx is **well-formed and both legs executed** — the
only true FAILURE is an account/PDA/discriminator/malformed error where a
leg never runs. So the smoke check passes when, for both directions: (a)
both program IDs appear in the sim logs, AND (b) `err` is `null` or a
slippage/amount-class error. This is encoded in the `acceptable()` helper
below — do not "fix" it to demand `err:null`.

- [ ] **Step 1: Write the script**

Create `scripts/smoke-clmm-orca-arb-sim.ts`:

```ts
/**
 * READ-ONLY smoke check: proves buildClmmOrcaArbTransaction produces a
 * well-formed ATOMIC two-leg (CLMM + Orca) tx that SIMULATES against real
 * mainnet state for BOTH direction assignments (sigVerify:false, surrogate
 * owner). The live-verification leg the design spec requires. Only
 * simulateTransaction is ever called; nothing is sent.
 *
 * Pass: for both directions, both program IDs appear in the sim logs AND
 * err is null OR a slippage/amount-class error (a well-formed tx whose
 * round-trip simply wasn't profitable). A malformed-account/PDA error
 * (a leg never reached its program) is the only FAIL.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "../src/decode/clmm.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "../src/txbuilder/clmmOrca.js";
import type { Opportunity } from "../src/types.js";

const CLMM_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SURROGATE = "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Well-formed if both legs reached their programs; err null OR slippage. */
function acceptable(err: unknown, logs: string[]): boolean {
  const hitBoth =
    logs.some((l) => l.includes(CLMM_PROGRAM)) &&
    logs.some((l) => l.includes(ORCA_PROGRAM));
  if (!hitBoth) return false; // a leg never executed → malformed
  if (err === null) return true; // a real gap cleared
  // Slippage/amount-class errors = well-formed tx, unprofitable round-trip.
  return /Custom|amount|Slippage|TooLittle|MinimumOut|0x1771/i.test(JSON.stringify(err));
}

async function main(): Promise<void> {
  const orcaPoolEnv = process.env.ORCA_POOL_ADDRESS;
  if (!orcaPoolEnv) throw new Error("set ORCA_POOL_ADDRESS (a SOL/USDC Orca whirlpool)");
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const clmmProgramId = new PublicKey(CLMM_PROGRAM);
  const orcaProgramId = new PublicKey(ORCA_PROGRAM);
  const clmmPool = new PublicKey(CLMM_POOL);
  const orcaPool = new PublicKey(orcaPoolEnv);
  const surrogate = new PublicKey(SURROGATE);

  const [clmmAcc, orcaAcc] = await connection.getMultipleAccountsInfo([clmmPool, orcaPool]);
  if (!clmmAcc || !orcaAcc) throw new Error("CLMM pool or Orca whirlpool not found");
  const clmmState = decodeClmmPool(clmmAcc.data);
  const orcaState = decodeWhirlpool(orcaAcc.data);

  if (clmmState.tokenMint0.toBase58() !== SOL_MINT) {
    throw new Error(
      `expected orientation NORMAL (SOL=mint0), got mint0=${clmmState.tokenMint0.toBase58()}`,
    );
  }

  const ammConfigAcc = await connection.getAccountInfo(clmmState.ammConfig);
  if (!ammConfigAcc) throw new Error("CLMM AmmConfig not found");
  const clmmFeeBps = decodeClmmAmmConfigFeeBps(ammConfigAcc.data);
  console.log(`[smoke] CLMM fee ${clmmFeeBps}bps; Orca fee ${orcaState.feeBps}bps`);

  const pair = {
    baseMint: SOL_MINT,
    quoteMint: USDC_MINT,
    baseDecimals: 9,
    quoteDecimals: 6,
  };
  const ctx = (blockhash: string): ClmmOrcaBuildContext => ({
    payer: surrogate, // PublicKey → unsigned build
    recentBlockhash: blockhash,
    pair,
    clmm: { programId: clmmProgramId, poolAddress: clmmPool, state: clmmState, tickCurrentIndex: clmmState.tickCurrentIndex },
    whirlpool: { programId: orcaProgramId, poolAddress: orcaPool, state: orcaState, tickCurrentIndex: orcaState.tickCurrentIndex },
  });

  // 100 USDC in, buy-leg min-out relaxed to 1 lamport-SOL (buy leg never
  // gates the shape check); the sell leg's min-out is quoteIn+0 per the
  // builder — see the pass criterion above for why err may be a slippage
  // error rather than null.
  const inputUsdc = 100_000_000n; // 100 USDC
  const opp = (buyOn: "raydium-clmm" | "orca-whirlpool"): Opportunity => ({
    decision: "opportunity",
    direction: {
      buyOn,
      sellOn: buyOn === "raydium-clmm" ? "orca-whirlpool" : "raydium-clmm",
    },
    gapBps: 0,
    quoteIn: inputUsdc,
    baseOut: 1n, // buy-leg min-out (relaxed)
    quoteOut: inputUsdc,
    estNetProfit: 0n,
    minProfitThreshold: 0n,
  });

  let allOk = true;
  for (const buyOn of ["raydium-clmm", "orca-whirlpool"] as const) {
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = buildClmmOrcaArbTransaction(ctx(blockhash), opp(buyOn));
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    const logs = sim.value.logs ?? [];
    const ok = acceptable(sim.value.err, logs);
    allOk = allOk && ok;
    console.log(`\n[smoke] direction buyOn=${buyOn}`);
    console.log(`[smoke]   err: ${JSON.stringify(sim.value.err)}`);
    console.log(`[smoke]   unitsConsumed: ${sim.value.unitsConsumed ?? "n/a"}`);
    console.log(`[smoke]   CLMM program in logs: ${logs.some((l) => l.includes(CLMM_PROGRAM))}`);
    console.log(`[smoke]   Orca program in logs: ${logs.some((l) => l.includes(ORCA_PROGRAM))}`);
    console.log(`[smoke]   acceptable (well-formed, both legs reached): ${ok}`);
    for (const l of logs.slice(-12)) console.log(`     ${l}`);
  }
  console.log(`\n[smoke] RESULT: ${allOk ? "PASS" : "FAIL"} (both directions well-formed)`);
  console.log("[smoke] NOTE: only simulateTransaction was called — nothing was sent.");
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Ensure `.env` has mainnet access + `ORCA_POOL_ADDRESS`**

The smoke check needs `HELIUS_API_KEY` (or `MAINNET_RPC_URL`) and
`ORCA_POOL_ADDRESS` (a SOL/USDC Orca whirlpool) in `.env` — the same
credentials the prior smoke checks used. Do NOT commit `.env`.

- [ ] **Step 3: Run the smoke check**

Run: `npx tsx scripts/smoke-clmm-orca-arb-sim.ts`
Expected: `[smoke] RESULT: PASS` — for BOTH `buyOn=raydium-clmm` and
`buyOn=orca-whirlpool`, `CLMM program in logs: true`, `Orca program in
logs: true`, `acceptable ...: true`, `unitsConsumed` in the ~90–100k order
of magnitude, and the final line confirming only `simulateTransaction` ran.

If a direction shows `acceptable: false`, inspect the last 12 log lines: an
account/PDA error (wrong tick-array, wrong observation, wrong vault) is a
real builder bug — fix in `src/txbuilder/clmmOrca.ts` (Task 1) and re-run
Task 1's tests before re-running this.

- [ ] **Step 4: Code-review the script for zero send capability**

Read the finished `scripts/smoke-clmm-orca-arb-sim.ts` and confirm it
contains no `sendRawTransaction`, no `sendTransaction`, and no signing —
only `simulateTransaction`. This is a required spec assertion.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-clmm-orca-arb-sim.ts
git commit -m "test: read-only mainnet sim smoke-check for clmm-orca atomic arb tx"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite + typecheck: `npm test && npx tsc --noEmit` — all green.
- [ ] Confirm the isolation boundary held: `git diff --stat master..HEAD` shows only the new files plus additive edits to `src/config.ts`, `src/main.ts`, `.env.example`, `tests/config.test.ts` (and the two new test files). No changes to any file on the do-not-touch list.
- [ ] The mainnet smoke-check passed for both directions (Task 5, Step 4).

## Out of scope (per spec — do NOT do here)

- The actual go/no-go shadow run and cutting the live `shadow-run-2` process over from two-Orca. Separate operational step after merge.
- ADR-0010 (captured when the venue actually runs).
- The `handoffMs`/latency-metric fix (orthogonal open finding).
- Any dedup/unification of the three arb-tx builders.
- Geyser support for `clmm-orca` (the setup throws for `DATA_SOURCE=geyser`).
