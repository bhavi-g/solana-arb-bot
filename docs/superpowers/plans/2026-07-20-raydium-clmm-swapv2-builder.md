# Raydium CLMM swap_v2 Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `buildClmmSwapV2Ix` — a Raydium CLMM `swap_v2` instruction builder plus its tick-array/bitmap-extension PDA helpers — proven correct by unit tests and a read-only mainnet simulation against the live pool.

**Architecture:** One new file, `src/txbuilder/raydiumClmm.ts`, structured exactly like the existing `src/txbuilder/orcaWhirlpool.ts` (discriminator constant, PDA helper functions, a params interface, one builder function). A new test file exercises it in isolation. A new read-only script proves it against live mainnet state via `simulateTransaction`. No existing file is modified.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), `@solana/web3.js` 1.98.4, `vitest` 2.1.8, `tsx` for scripts.

## Global Constraints

- **Isolation boundary (owner-approved, non-negotiable):** touch only new files — `src/txbuilder/raydiumClmm.ts`, `tests/raydiumClmm.test.ts`, `scripts/smoke-clmm-swap-sim.ts`. Do NOT edit `src/datasource/orcaOrcaPolling.ts`, `src/datasource/polling.ts`, `src/math/whirlpool.ts`, `src/detect.ts`, `src/txbuilder/orcaWhirlpool.ts`, `src/txbuilder/twoWhirlpool.ts`, `src/txbuilder/index.ts`, or `src/decode/clmm.ts`. You may *import* read-only from `src/txbuilder/index.ts` and `src/decode/clmm.ts` — importing is not editing.
- **Instruction is `swap_v2`** (not legacy `swap`), per owner decision recorded in the design spec.
- **Tick-array selection is the fixed 3-array heuristic** (current array + next two in swap direction), not `tick_array_bitmap` discovery — mirrors `orcaWhirlpool.ts`. This is a documented limitation for large trade sizes, not a bug to fix here.
- **Dual-source verification is mandatory before calling this done:** the account list, order, writable/signer flags, and data layout below were transcribed from raydium-clmm source (`programs/amm/src/instructions/swap_v2.rs` @ pinned commit `03b44b7`, same commit already cited in `src/decode/clmm.ts`) AND cross-checked against the vendored `@raydium-io/raydium-sdk-v2` reference implementation (`node_modules/@raydium-io/raydium-sdk-v2/src/raydium/clmm/instrument.ts`, `swapV2Instruction`, and `node_modules/@raydium-io/raydium-sdk-v2/src/raydium/clmm/libraries/{pda,constants}.ts`) — both already reflected in the code blocks in this plan. Task 3's live simulation is the third, final leg — do not consider the builder done on source-only or sim-only verification.
- **No new error-throwing surface.** `buildClmmSwapV2Ix` does not validate its inputs (e.g. does not guard `amount < 0n`) — this matches `buildWhirlpoolSwapIx` and `buildCpmmSwapBaseInputIx`, which trust their callers. Do not add validation.
- Commits go directly to `master` as `T<n>: summary` (T47 was the design-spec commit, T48 this plan's own commit; use T49 onward for this plan's task commits — confirm the next free number with `git log --oneline | grep -oE 'T[0-9]+' | head -1` before the first commit since another session may have advanced it).

---

### Task 1: Constants and PDA helpers

**Files:**
- Create: `src/txbuilder/raydiumClmm.ts` (this task writes the top portion only — constants + PDA helper functions)
- Test: `tests/raydiumClmm.test.ts` (this task writes the top portion only)

**Interfaces:**
- Consumes: nothing (pure, no imports beyond `@solana/web3.js` and `node:crypto`)
- Produces (for Task 2 and Task 3 to consume):
  - `CLMM_SWAP_V2_DISCRIMINATOR: Buffer` (8 bytes)
  - `CLMM_TICK_ARRAY_SIZE: number` (= 60)
  - `CLMM_MIN_SQRT_PRICE_X64: bigint`, `CLMM_MAX_SQRT_PRICE_X64: bigint`
  - `TOKEN_2022_PROGRAM_ID: PublicKey`, `MEMO_PROGRAM_ID: PublicKey`
  - `clmmTickArrayStartIndex(tick: number, tickSpacing: number): number`
  - `clmmTickArrayPda(programId: PublicKey, pool: PublicKey, startIndex: number): PublicKey`
  - `tickArrayBitmapExtensionPda(programId: PublicKey, pool: PublicKey): PublicKey`

- [ ] **Step 1: Write the failing tests**

Create `tests/raydiumClmm.test.ts`:

```typescript
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLMM_SWAP_V2_DISCRIMINATOR,
  clmmTickArrayPda,
  clmmTickArrayStartIndex,
  tickArrayBitmapExtensionPda,
} from "../src/txbuilder/raydiumClmm.js";

const kp = () => Keypair.generate().publicKey;

describe("CLMM_SWAP_V2_DISCRIMINATOR", () => {
  it("matches sha256(global:swap_v2)[0..8]", () => {
    expect(Buffer.from(CLMM_SWAP_V2_DISCRIMINATOR).toString("hex")).toBe(
      createHash("sha256").update("global:swap_v2").digest().subarray(0, 8).toString("hex"),
    );
  });
});

describe("clmmTickArrayStartIndex", () => {
  it("floors toward negative infinity for negative ticks", () => {
    // tickSpacing=10, CLMM_TICK_ARRAY_SIZE=60 => 600 ticks per array
    expect(clmmTickArrayStartIndex(0, 10)).toBe(0);
    expect(clmmTickArrayStartIndex(599, 10)).toBe(0);
    expect(clmmTickArrayStartIndex(600, 10)).toBe(600);
    expect(clmmTickArrayStartIndex(-1, 10)).toBe(-600);
    // the live pool's current tick per the design spec (mainnet, 2026-07-20)
    expect(clmmTickArrayStartIndex(-25_696, 10)).toBe(-25_800);
  });
});

describe("clmmTickArrayPda", () => {
  it("is deterministic and varies by start index, including negative indices", () => {
    const programId = kp();
    const pool = kp();
    const a1 = clmmTickArrayPda(programId, pool, -25_800);
    const a2 = clmmTickArrayPda(programId, pool, -25_800);
    const b = clmmTickArrayPda(programId, pool, -25_200);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });

  it("varies by pool", () => {
    const programId = kp();
    const a = clmmTickArrayPda(programId, kp(), -25_800);
    const b = clmmTickArrayPda(programId, kp(), -25_800);
    expect(a.equals(b)).toBe(false);
  });
});

describe("tickArrayBitmapExtensionPda", () => {
  it("is deterministic and varies by pool", () => {
    const programId = kp();
    const pool = kp();
    expect(
      tickArrayBitmapExtensionPda(programId, pool).equals(
        tickArrayBitmapExtensionPda(programId, pool),
      ),
    ).toBe(true);
    expect(
      tickArrayBitmapExtensionPda(programId, pool).equals(
        tickArrayBitmapExtensionPda(programId, kp()),
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/raydiumClmm.test.ts`
Expected: FAIL — `Cannot find module '../src/txbuilder/raydiumClmm.js'`

- [ ] **Step 3: Write the implementation**

Create `src/txbuilder/raydiumClmm.ts`:

```typescript
/**
 * Raydium CLMM swap_v2 instruction builder.
 * Account order, writable/signer flags, and instruction data layout
 * verified against raydium-io/raydium-clmm
 * programs/amm/src/instructions/swap_v2.rs @ 03b44b7 (master, 2026-07-20)
 * AND cross-checked against the vendored @raydium-io/raydium-sdk-v2
 * reference builder (node_modules/@raydium-io/raydium-sdk-v2/src/raydium/
 * clmm/instrument.ts, swapV2Instruction). Both checks are required — do
 * not trust one alone. Final confirmation is the mainnet simulation
 * smoke-check (scripts/smoke-clmm-swap-sim.ts).
 *
 * Tick arrays: fixed 3-array heuristic mirroring orcaWhirlpool.ts (not
 * full tick_array_bitmap discovery) — see design spec
 * docs/superpowers/specs/2026-07-20-raydium-clmm-swapv2-builder-design.md.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Anchor: sha256("global:swap_v2")[0..8]. */
export const CLMM_SWAP_V2_DISCRIMINATOR = createHash("sha256")
  .update("global:swap_v2")
  .digest()
  .subarray(0, 8);

// CLMM's array size (60) differs from Orca's (88) — libraries/constants.ts.
export const CLMM_TICK_ARRAY_SIZE = 60;
// Program constants (token math bounds), from raydium-clmm
// libraries/constants.ts. MIN happens to equal Orca's MIN_SQRT_PRICE;
// MAX does NOT — CLMM defines its own bounds independently.
export const CLMM_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const CLMM_MAX_SQRT_PRICE_X64 = 79_226_673_521_066_979_257_578_248_091n;

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export function clmmTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * CLMM_TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Seed is ["tick_array", pool, startIndex as i32 BIG-ENDIAN] — the
 * critical divergence from Orca, whose seed is the start index as an
 * ASCII decimal string. Verified against raydium-clmm's
 * i32ToBytesBE (writeInt32BE) via the vendored SDK's getPdaTickArrayAddress.
 */
export function clmmTickArrayPda(
  programId: PublicKey,
  pool: PublicKey,
  startIndex: number,
): PublicKey {
  const startIndexBuf = Buffer.alloc(4);
  startIndexBuf.writeInt32BE(startIndex, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), pool.toBuffer(), startIndexBuf],
    programId,
  )[0];
}

export function tickArrayBitmapExtensionPda(
  programId: PublicKey,
  pool: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()],
    programId,
  )[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/raydiumClmm.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/txbuilder/raydiumClmm.ts tests/raydiumClmm.test.ts
git commit -m "T49: CLMM swap_v2 discriminator + tick-array/bitmap PDA helpers"
```

---

### Task 2: `buildClmmSwapV2Ix` instruction builder

**Files:**
- Modify: `src/txbuilder/raydiumClmm.ts` (append params interface + builder function)
- Modify: `tests/raydiumClmm.test.ts` (append builder tests)

**Interfaces:**
- Consumes: everything Task 1 produced (same file — no import needed), plus `TOKEN_PROGRAM_ID: PublicKey` imported (read-only) from `./index.js` (already exported at `src/txbuilder/index.ts:25`).
- Produces (for Task 3 to consume):
  - `interface ClmmSwapV2Params { programId, payer, ammConfig, poolState, inputTokenAccount, outputTokenAccount, inputVault, outputVault, observationState, inputVaultMint, outputVaultMint, tickCurrentIndex: number, tickSpacing: number, amount: bigint, otherAmountThreshold: bigint, inputIsToken0: boolean }`
  - `buildClmmSwapV2Ix(p: ClmmSwapV2Params): TransactionInstruction`

- [ ] **Step 1: Write the failing tests**

Append to `tests/raydiumClmm.test.ts` (add to the existing import block and add new `describe` blocks):

```typescript
import {
  buildClmmSwapV2Ix,
  CLMM_MAX_SQRT_PRICE_X64,
  CLMM_MIN_SQRT_PRICE_X64,
  clmmTickArrayPda,
  clmmTickArrayStartIndex,
  tickArrayBitmapExtensionPda,
  // (CLMM_SWAP_V2_DISCRIMINATOR and the rest are already imported above)
} from "../src/txbuilder/raydiumClmm.js";
import { TOKEN_PROGRAM_ID } from "../src/txbuilder/index.js";

describe("buildClmmSwapV2Ix", () => {
  const base = {
    programId: kp(),
    payer: kp(),
    ammConfig: kp(),
    poolState: kp(),
    inputTokenAccount: kp(),
    outputTokenAccount: kp(),
    inputVault: kp(),
    outputVault: kp(),
    observationState: kp(),
    inputVaultMint: kp(),
    outputVaultMint: kp(),
    tickCurrentIndex: -25_696,
    tickSpacing: 10,
    amount: 100_000n,
    otherAmountThreshold: 0n,
  };

  it("is 41 bytes: discriminator + amount + threshold + sqrt-price-limit + is_base_input", () => {
    const ix = buildClmmSwapV2Ix({ ...base, inputIsToken0: true });
    expect(ix.data.length).toBe(41);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe(
      Buffer.from(CLMM_SWAP_V2_DISCRIMINATOR).toString("hex"),
    );
    expect(ix.data.readBigUInt64LE(8)).toBe(100_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(0n);
    expect(ix.data.readUInt8(40)).toBe(1); // is_base_input = true
  });

  it("sets sqrt_price_limit_x64 to MIN for inputIsToken0=true, MAX for false", () => {
    const t0 = buildClmmSwapV2Ix({ ...base, inputIsToken0: true });
    const lo0 = t0.data.readBigUInt64LE(24);
    const hi0 = t0.data.readBigUInt64LE(32);
    expect((hi0 << 64n) | lo0).toBe(CLMM_MIN_SQRT_PRICE_X64);

    const t1 = buildClmmSwapV2Ix({ ...base, inputIsToken0: false });
    const lo1 = t1.data.readBigUInt64LE(24);
    const hi1 = t1.data.readBigUInt64LE(32);
    expect((hi1 << 64n) | lo1).toBe(CLMM_MAX_SQRT_PRICE_X64);
  });

  it("orders all 17 accounts with correct writable/signer flags", () => {
    const ix = buildClmmSwapV2Ix({ ...base, inputIsToken0: true });
    expect(ix.keys.length).toBe(17);

    expect(ix.keys[0]!.pubkey.equals(base.payer)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(false);

    expect(ix.keys[1]!.pubkey.equals(base.ammConfig)).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(false);

    expect(ix.keys[2]!.pubkey.equals(base.poolState)).toBe(true);
    expect(ix.keys[2]!.isWritable).toBe(true);

    expect(ix.keys[3]!.pubkey.equals(base.inputTokenAccount)).toBe(true);
    expect(ix.keys[3]!.isWritable).toBe(true);

    expect(ix.keys[4]!.pubkey.equals(base.outputTokenAccount)).toBe(true);
    expect(ix.keys[4]!.isWritable).toBe(true);

    expect(ix.keys[5]!.pubkey.equals(base.inputVault)).toBe(true);
    expect(ix.keys[5]!.isWritable).toBe(true);

    expect(ix.keys[6]!.pubkey.equals(base.outputVault)).toBe(true);
    expect(ix.keys[6]!.isWritable).toBe(true);

    expect(ix.keys[7]!.pubkey.equals(base.observationState)).toBe(true);
    expect(ix.keys[7]!.isWritable).toBe(true);

    expect(ix.keys[8]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[8]!.isWritable).toBe(false);

    expect(ix.keys[9]!.pubkey.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(ix.keys[9]!.isWritable).toBe(false);

    expect(ix.keys[10]!.pubkey.toBase58()).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    expect(ix.keys[10]!.isWritable).toBe(false);

    expect(ix.keys[11]!.pubkey.equals(base.inputVaultMint)).toBe(true);
    expect(ix.keys[11]!.isWritable).toBe(false);

    expect(ix.keys[12]!.pubkey.equals(base.outputVaultMint)).toBe(true);
    expect(ix.keys[12]!.isWritable).toBe(false);

    expect(
      ix.keys[13]!.pubkey.equals(tickArrayBitmapExtensionPda(base.programId, base.poolState)),
    ).toBe(true);
    expect(ix.keys[13]!.isWritable).toBe(true);

    expect(ix.keys[14]!.isWritable).toBe(true);
    expect(ix.keys[15]!.isWritable).toBe(true);
    expect(ix.keys[16]!.isWritable).toBe(true);
  });

  it("walks tick arrays toward lower start indices for inputIsToken0=true, higher for false", () => {
    const t0 = buildClmmSwapV2Ix({ ...base, inputIsToken0: true });
    const t1 = buildClmmSwapV2Ix({ ...base, inputIsToken0: false });
    const start = clmmTickArrayStartIndex(base.tickCurrentIndex, base.tickSpacing);

    // first array always contains the current tick, regardless of direction
    expect(
      t0.keys[14]!.pubkey.equals(clmmTickArrayPda(base.programId, base.poolState, start)),
    ).toBe(true);
    expect(t0.keys[14]!.pubkey.equals(t1.keys[14]!.pubkey)).toBe(true);
    // second array diverges by direction
    expect(t0.keys[15]!.pubkey.equals(t1.keys[15]!.pubkey)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/raydiumClmm.test.ts`
Expected: FAIL — `buildClmmSwapV2Ix is not a function` / `CLMM_MAX_SQRT_PRICE_X64` etc. not exported from the builder tests (Task-1 exports already pass; the new `describe("buildClmmSwapV2Ix", ...)` block fails).

- [ ] **Step 3: Write the implementation**

Append to `src/txbuilder/raydiumClmm.ts` (add the import at the top alongside the existing ones, then the interface and function at the bottom):

```typescript
import { TOKEN_PROGRAM_ID } from "./index.js";
```

```typescript
export interface ClmmSwapV2Params {
  programId: PublicKey;
  payer: PublicKey;
  ammConfig: PublicKey;
  poolState: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  observationState: PublicKey;
  inputVaultMint: PublicKey;
  outputVaultMint: PublicKey;
  tickCurrentIndex: number;
  tickSpacing: number;
  /** Input amount (is_base_input is always true here). */
  amount: bigint;
  /** Minimum output amount — enforces profitability atomically. */
  otherAmountThreshold: bigint;
  /**
   * Whether the INPUT side is the pool's token_mint_0. The
   * input/output accounts above are already resolved by the caller
   * (swap_v2's accounts are literally "input_*"/"output_*", unlike
   * Orca's fixed A/B ordering) — this flag does NOT reorder them. It
   * independently drives the tick-array walk direction and the
   * sqrt_price_limit_x64 bound, because swap_v2's instruction DATA
   * carries no separate zero_for_one byte: the program infers
   * direction on-chain by comparing input_vault_mint to the pool's
   * token_mint_0, so the client must still supply a price limit
   * consistent with that same direction.
   */
  inputIsToken0: boolean;
}

export function buildClmmSwapV2Ix(p: ClmmSwapV2Params): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1);
  data.set(CLMM_SWAP_V2_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.amount, 8);
  data.writeBigUInt64LE(p.otherAmountThreshold, 16);
  const sqrtPriceLimit = p.inputIsToken0 ? CLMM_MIN_SQRT_PRICE_X64 : CLMM_MAX_SQRT_PRICE_X64;
  data.writeBigUInt64LE(sqrtPriceLimit & 0xffffffffffffffffn, 24);
  data.writeBigUInt64LE(sqrtPriceLimit >> 64n, 32);
  data.writeUInt8(1, 40); // is_base_input = true

  const ticksPerArray = p.tickSpacing * CLMM_TICK_ARRAY_SIZE;
  const start = clmmTickArrayStartIndex(p.tickCurrentIndex, p.tickSpacing);
  const step = p.inputIsToken0 ? -ticksPerArray : ticksPerArray;
  const tickArrays = [start, start + step, start + 2 * step].map((s) =>
    clmmTickArrayPda(p.programId, p.poolState, s),
  );

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: false },
      { pubkey: p.ammConfig, isSigner: false, isWritable: false },
      { pubkey: p.poolState, isSigner: false, isWritable: true },
      { pubkey: p.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.inputVault, isSigner: false, isWritable: true },
      { pubkey: p.outputVault, isSigner: false, isWritable: true },
      { pubkey: p.observationState, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: p.inputVaultMint, isSigner: false, isWritable: false },
      { pubkey: p.outputVaultMint, isSigner: false, isWritable: false },
      {
        pubkey: tickArrayBitmapExtensionPda(p.programId, p.poolState),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: tickArrays[0]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[1]!, isSigner: false, isWritable: true },
      { pubkey: tickArrays[2]!, isSigner: false, isWritable: true },
    ],
    data,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/raydiumClmm.test.ts`
Expected: PASS (10 tests total)

- [ ] **Step 5: Full suite + typecheck (isolation check)**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite passes with the same count as before this plan plus the 10 new tests (no existing test regresses — confirms the isolation boundary held).

- [ ] **Step 6: Commit**

```bash
git add src/txbuilder/raydiumClmm.ts tests/raydiumClmm.test.ts
git commit -m "T50: buildClmmSwapV2Ix — Raydium CLMM swap_v2 instruction builder"
```

---

### Task 3: Mainnet simulation smoke-check

**Files:**
- Create: `scripts/smoke-clmm-swap-sim.ts`

**Interfaces:**
- Consumes: `decodeClmmPool` from `src/decode/clmm.ts` (existing, read-only import), `associatedTokenAddress` from `src/txbuilder/index.ts` (existing, read-only import), `buildClmmSwapV2Ix` from `src/txbuilder/raydiumClmm.ts` (Task 2).
- Produces: nothing consumed by later tasks — this is the terminal verification leg.

- [ ] **Step 1: Write the script**

Create `scripts/smoke-clmm-swap-sim.ts`:

```typescript
/**
 * READ-ONLY smoke check: proves buildClmmSwapV2Ix produces a well-formed
 * Raydium CLMM swap_v2 instruction that SIMULATES against real mainnet
 * pool state (sigVerify:false, surrogate owner) — the live-verification
 * leg the design spec requires (source-only or sim-only is not enough).
 * Only simulateTransaction is ever called; nothing is sent.
 */
import "dotenv/config";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeClmmPool } from "../src/decode/clmm.js";
import { associatedTokenAddress } from "../src/txbuilder/index.js";
import { buildClmmSwapV2Ix } from "../src/txbuilder/raydiumClmm.js";

const POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
const SURROGATE = "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const programId = new PublicKey(CLMM_PROGRAM);
  const pool = new PublicKey(POOL);
  const surrogate = new PublicKey(SURROGATE);

  const poolAcc = await connection.getAccountInfo(pool);
  if (!poolAcc) throw new Error(`pool ${POOL} account not found`);
  const state = decodeClmmPool(poolAcc.data);

  if (state.tokenMint0.toBase58() !== SOL_MINT) {
    throw new Error(
      `expected orientation NORMAL (SOL=mint0), got mint0=${state.tokenMint0.toBase58()} — ` +
        `inputIsToken0 below assumes this orientation`,
    );
  }

  // USDC (mint1) -> SOL (mint0): input is NOT token0.
  const inputAmount = 100_000n; // 0.1 USDC (6 decimals) — smoke size only
  const ix = buildClmmSwapV2Ix({
    programId,
    payer: surrogate,
    ammConfig: state.ammConfig,
    poolState: pool,
    inputTokenAccount: associatedTokenAddress(surrogate, state.tokenMint1),
    outputTokenAccount: associatedTokenAddress(surrogate, state.tokenMint0),
    inputVault: state.tokenVault1,
    outputVault: state.tokenVault0,
    observationState: state.observationKey,
    inputVaultMint: state.tokenMint1,
    outputVaultMint: state.tokenMint0,
    tickCurrentIndex: state.tickCurrentIndex,
    tickSpacing: state.tickSpacing,
    amount: inputAmount,
    otherAmountThreshold: 0n,
    inputIsToken0: false,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: surrogate,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  console.log(`[smoke] simulate err: ${JSON.stringify(sim.value.err)}`);
  console.log(`[smoke] unitsConsumed: ${sim.value.unitsConsumed ?? "n/a"}`);
  const logs = sim.value.logs ?? [];
  console.log(`[smoke] CLMM program in logs: ${logs.some((l) => l.includes(CLMM_PROGRAM))}`);
  console.log(`[smoke] logs tail:`);
  for (const l of logs.slice(-12)) console.log(`   ${l}`);
  console.log("[smoke] NOTE: only simulateTransaction was called — nothing was sent.");
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Confirm zero send capability (manual code-review gate)**

Run: `grep -n "sendRawTransaction\|sendTransaction" scripts/smoke-clmm-swap-sim.ts`
Expected: no output (nothing matched) — the script can only call `simulateTransaction`.

- [ ] **Step 4: Run the smoke check against live mainnet**

Run: `npx tsx scripts/smoke-clmm-swap-sim.ts`
Expected:
- `[smoke] simulate err: null`
- `[smoke] CLMM program in logs: true`
- `[smoke] unitsConsumed:` some value on the order of tens of thousands (comparable in magnitude to the ~56k CU the two-Orca smoke check measured — this is a sanity read, not a hard-coded assertion, since CU cost legitimately varies with tick-array count and account rent state)

If `err` is non-null: this is the expected failure mode during development the design spec calls out (a wrong tick-array PDA, wrong discriminator, or misordered account produces a concrete on-chain error). Read the error/logs, fix the specific field in `src/txbuilder/raydiumClmm.ts`, re-run from Step 2. Do not proceed to Step 5 until `err: null`.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-clmm-swap-sim.ts
git commit -m "T51: CLMM swap_v2 mainnet simulation smoke-check (err:null verified)"
```

---

## Post-plan state

- `buildClmmSwapV2Ix` exists, unit-tested, and live-simulation-verified against the real Raydium CLMM program and the live pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`.
- Zero edits to any existing venue/detection/tx-builder file — the running two-Orca shadow process is untouched.
- Out of scope, per the design spec, and NOT built by this plan: `buildClmmOrcaArbTransaction` (the atomic two-leg arb tx), a `clmm-orca` polling source, and `VENUE="clmm-orca"` wiring in `main.ts`. These are the follow-up spec's job.
