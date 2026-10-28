# Raydium CLMM Decoder + Math Foundation Implementation Plan


**Goal:** Decode Raydium CLMM pools (pool account + separate AmmConfig fee) into the existing `WhirlpoolSnapshot` shape so cross-DEX Raydium-vs-Orca opportunities can be detected with zero changes to the detection engine.

**Architecture:** Raydium CLMM is a Uniswap-V3-family concentrated-liquidity AMM storing a Q64.64 sqrt price, same family as Orca Whirlpool. We add a new decoder (`src/decode/clmm.ts`) and reuse `src/math/whirlpool.ts` unchanged. A CLMM pool emits `kind: "whirlpool"` with `dex: "raydium-clmm"` (Approach A), so `detect.ts` needs no changes. Read-side only; the swap tx-builder is a follow-up spec.

**Tech Stack:** TypeScript, `@solana/web3.js`, `@raydium-io/raydium-sdk-v2` (probe only), vitest. Zero-copy `repr(packed)` account layouts → fixed byte offsets.

## Global Constraints

- **Isolation boundary (hard):** NO edits to `src/datasource/orcaOrcaPolling.ts`, NO edits to `src/math/whirlpool.ts`, NO logic edits to `src/detect.ts`. The running 72h two-Orca shadow uses that code path and must stay untouched. Shared-file edits are limited to purely **additive** changes: a new function in `src/decode/layout.ts`, and a union member + doc comment in `src/types.ts`.
- **Dual-source offset verification (mandatory):** every offset in `src/decode/clmm.ts` must be verified against BOTH (1) the pinned raydium-clmm source commit (recorded in the file header) AND (2) live captured mainnet account data (Task 6 probe). Do not consider the decoder done on source-only or live-only.
- **Orientation report (mandatory):** when Task 6 selects the real pool, report to the owner explicitly whether it is inverted (SOL as `mint_1`) or not — either way, stated, not silently handled.
- **Money math:** token amounts are always `bigint` base units; fee rates are integer basis points (ppm ÷ 100). No floating point in trade math (`sqrtPriceX64ToPrice` is logging-only).
- **Fee is a separate account:** CLMM `trade_fee_rate` lives in `AmmConfig` (`u32` ppm), NOT the pool. Do not reuse `decodeAmmConfigFeeBps` from `raydiumCpmm.ts` — that config layout is different (`u64` @12).
- **Known constants:** WSOL mint `So11111111111111111111111111111111111111112`, USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, Raydium CLMM program `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`. Discover addresses live; never trust remembered pool addresses.
- **Scope trim:** the pool `status` bitfield is deliberately NOT decoded in this foundation (it sits in the version-sensitive struct tail after four `u128` swap-amount fields; liveness only matters for the tx-builder). Deferred to the follow-up spec.

---

### Task 1: `readU32` little-endian primitive

**Files:**
- Modify: `src/decode/layout.ts` (additive — new function only)
- Test: `tests/layout.test.ts` (create)

**Interfaces:**
- Produces: `readU32(data: Uint8Array, offset: number): number` (in `src/decode/layout.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/layout.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readU32 } from "../src/decode/layout.js";

describe("readU32", () => {
  it("reads a little-endian u32", () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(readU32(buf, 0)).toBe(0x04030201);
  });

  it("reads at a non-zero offset", () => {
    const buf = new Uint8Array([0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
    expect(readU32(buf, 2)).toBe(0xffffffff);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL — `readU32` is not exported from `../src/layout.js`.

- [ ] **Step 3: Add the implementation**

Append to `src/decode/layout.ts`:

```typescript
export function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/layout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decode/layout.ts tests/layout.test.ts
git commit -m "T41: readU32 LE primitive (additive) for CLMM AmmConfig fee decode"
```

---

### Task 2: `decodeClmmPool`

**Files:**
- Create: `src/decode/clmm.ts`
- Test: `tests/clmm.test.ts` (create)

**Interfaces:**
- Consumes: `readU128`, `readI32`, `readU16` from `src/decode/layout.ts` (same directory — import `./layout.js`)
- Produces:
  - `interface ClmmPoolState { ammConfig: PublicKey; tokenMint0: PublicKey; tokenMint1: PublicKey; tokenVault0: PublicKey; tokenVault1: PublicKey; observationKey: PublicKey; mintDecimals0: number; mintDecimals1: number; tickSpacing: number; liquidity: bigint; sqrtPriceX64: bigint; tickCurrentIndex: number; }`
  - `decodeClmmPool(data: Uint8Array): ClmmPoolState`
  - `const CLMM_POOL_STATE_MIN_LEN: number`

Offsets are computed from the zero-copy `repr(packed)` `PoolState` (after the 8-byte Anchor discriminator): amm_config @9, owner @41, token_mint_0 @73, token_mint_1 @105, token_vault_0 @137, token_vault_1 @169, observation_key @201, mint_decimals_0 @233, mint_decimals_1 @234, tick_spacing @235, liquidity @237, sqrt_price_x64 @253, tick_current @269.

- [ ] **Step 1: Write the failing test**

Create `tests/clmm.test.ts`:

```typescript
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  decodeClmmPool,
  CLMM_POOL_STATE_MIN_LEN,
} from "../src/decode/clmm.js";

function writeU128(buf: Uint8Array, offset: number, v: bigint) {
  for (let i = 0; i < 16; i++) buf[offset + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}
function writeU16(buf: Uint8Array, offset: number, v: number) {
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >> 8) & 0xff;
}
function writeI32(buf: Uint8Array, offset: number, v: number) {
  new DataView(buf.buffer, buf.byteOffset + offset, 4).setInt32(0, v, true);
}

describe("decodeClmmPool", () => {
  it("extracts config, mints, vaults, decimals and price fields at verified offsets", () => {
    const buf = new Uint8Array(CLMM_POOL_STATE_MIN_LEN + 400);
    const ammConfig = Keypair.generate().publicKey;
    const mint0 = Keypair.generate().publicKey;
    const mint1 = Keypair.generate().publicKey;
    const vault0 = Keypair.generate().publicKey;
    const vault1 = Keypair.generate().publicKey;
    const observation = Keypair.generate().publicKey;
    buf.set(ammConfig.toBytes(), 9);
    buf.set(mint0.toBytes(), 73);
    buf.set(mint1.toBytes(), 105);
    buf.set(vault0.toBytes(), 137);
    buf.set(vault1.toBytes(), 169);
    buf.set(observation.toBytes(), 201);
    buf[233] = 9; // mint0 decimals
    buf[234] = 6; // mint1 decimals
    writeU16(buf, 235, 8); // tick spacing
    writeU128(buf, 237, 123_456_789n); // liquidity
    writeU128(buf, 253, 7_144_300_000_000_000_000n); // sqrt price x64
    writeI32(buf, 269, -18_000); // tick current (negative -> signed check)

    const s = decodeClmmPool(buf);
    expect(s.ammConfig.equals(ammConfig)).toBe(true);
    expect(s.tokenMint0.equals(mint0)).toBe(true);
    expect(s.tokenMint1.equals(mint1)).toBe(true);
    expect(s.tokenVault0.equals(vault0)).toBe(true);
    expect(s.tokenVault1.equals(vault1)).toBe(true);
    expect(s.observationKey.equals(observation)).toBe(true);
    expect(s.mintDecimals0).toBe(9);
    expect(s.mintDecimals1).toBe(6);
    expect(s.tickSpacing).toBe(8);
    expect(s.liquidity).toBe(123_456_789n);
    expect(s.sqrtPriceX64).toBe(7_144_300_000_000_000_000n);
    expect(s.tickCurrentIndex).toBe(-18_000);
  });

  it("throws on a too-short buffer", () => {
    expect(() => decodeClmmPool(new Uint8Array(10))).toThrow(/too short/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clmm.test.ts`
Expected: FAIL — cannot import `decodeClmmPool` from `../src/decode/clmm.js`.

- [ ] **Step 3: Write the implementation**

Create `src/decode/clmm.ts`:

```typescript
/**
 * Raydium CLMM (concentrated liquidity) account decoding.
 *
 * Field order verified against raydium-io/raydium-clmm
 * programs/amm/src/states/{pool,config}.rs @ <PINNED_COMMIT> AND against
 * live mainnet account data (scripts/probe-mainnet-clmm-pools.ts). Both
 * checks are required — do not trust one alone.
 *
 * PoolState is a zero-copy repr(packed) account: 8-byte Anchor
 * discriminator, then C-packed fields with no alignment padding, so every
 * offset below is fixed byte arithmetic.
 *
 * WARNING: the fee is NOT in this account. It lives in the referenced
 * AmmConfig (decodeClmmAmmConfigFeeBps). CLMM's AmmConfig layout differs
 * from Raydium CPMM's AmmConfig — do NOT reuse raydiumCpmm's decoder.
 */
import { PublicKey } from "@solana/web3.js";
import { readI32, readU16, readU128 } from "./layout.js";

// offsets after the 8-byte discriminator (repr(packed) PoolState):
// bump [u8;1] @8, owner Pubkey @41 (skipped)
const AMM_CONFIG = 9;
const TOKEN_MINT_0 = 73;
const TOKEN_MINT_1 = 105;
const TOKEN_VAULT_0 = 137;
const TOKEN_VAULT_1 = 169;
const OBSERVATION_KEY = 201;
const MINT_DECIMALS_0 = 233;
const MINT_DECIMALS_1 = 234;
const TICK_SPACING = 235; // u16
const LIQUIDITY = 237; // u128
const SQRT_PRICE_X64 = 253; // u128
const TICK_CURRENT = 269; // i32

export const CLMM_POOL_STATE_MIN_LEN = TICK_CURRENT + 4;

export interface ClmmPoolState {
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  observationKey: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrentIndex: number;
}

export function decodeClmmPool(data: Uint8Array): ClmmPoolState {
  if (data.length < CLMM_POOL_STATE_MIN_LEN) {
    throw new Error(
      `ClmmPoolState too short: ${data.length} < ${CLMM_POOL_STATE_MIN_LEN}`,
    );
  }
  return {
    ammConfig: new PublicKey(data.slice(AMM_CONFIG, AMM_CONFIG + 32)),
    tokenMint0: new PublicKey(data.slice(TOKEN_MINT_0, TOKEN_MINT_0 + 32)),
    tokenMint1: new PublicKey(data.slice(TOKEN_MINT_1, TOKEN_MINT_1 + 32)),
    tokenVault0: new PublicKey(data.slice(TOKEN_VAULT_0, TOKEN_VAULT_0 + 32)),
    tokenVault1: new PublicKey(data.slice(TOKEN_VAULT_1, TOKEN_VAULT_1 + 32)),
    observationKey: new PublicKey(
      data.slice(OBSERVATION_KEY, OBSERVATION_KEY + 32),
    ),
    mintDecimals0: data[MINT_DECIMALS_0]!,
    mintDecimals1: data[MINT_DECIMALS_1]!,
    tickSpacing: readU16(data, TICK_SPACING),
    liquidity: readU128(data, LIQUIDITY),
    sqrtPriceX64: readU128(data, SQRT_PRICE_X64),
    tickCurrentIndex: readI32(data, TICK_CURRENT),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/clmm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decode/clmm.ts tests/clmm.test.ts
git commit -m "T42: decodeClmmPool — Raydium CLMM pool account (offsets from repr(packed))"
```

---

### Task 3: `decodeClmmAmmConfigFeeBps`

**Files:**
- Modify: `src/decode/clmm.ts`
- Test: `tests/clmm.test.ts` (add cases)

**Interfaces:**
- Consumes: `readU32` from `src/decode/layout.ts` (Task 1; import `./layout.js`)
- Produces: `decodeClmmAmmConfigFeeBps(data: Uint8Array): number` — trade fee in basis points
- Produces: `const CLMM_AMM_CONFIG_MIN_LEN: number`

AmmConfig zero-copy `repr(packed)` layout (after 8-byte discriminator): bump u8 @8, index u16 @9, owner Pubkey @11, protocol_fee_rate u32 @43, trade_fee_rate u32 @47 (ppm, denominator 1e6).

- [ ] **Step 1: Write the failing test**

Add to `tests/clmm.test.ts` (new imports + describe block):

```typescript
import {
  decodeClmmAmmConfigFeeBps,
  CLMM_AMM_CONFIG_MIN_LEN,
} from "../src/decode/clmm.js";

function writeU32(buf: Uint8Array, offset: number, v: number) {
  new DataView(buf.buffer, buf.byteOffset + offset, 4).setUint32(0, v, true);
}

describe("decodeClmmAmmConfigFeeBps", () => {
  it("converts trade_fee_rate ppm at offset 47 to basis points", () => {
    const buf = new Uint8Array(CLMM_AMM_CONFIG_MIN_LEN);
    writeU32(buf, 47, 2_500); // 2500 ppm = 0.25% = 25 bps
    expect(decodeClmmAmmConfigFeeBps(buf)).toBe(25);
  });

  it("handles a 1 bps tier (100 ppm)", () => {
    const buf = new Uint8Array(CLMM_AMM_CONFIG_MIN_LEN);
    writeU32(buf, 47, 100); // 100 ppm = 0.01% = 1 bps
    expect(decodeClmmAmmConfigFeeBps(buf)).toBe(1);
  });

  it("throws on a too-short buffer", () => {
    expect(() => decodeClmmAmmConfigFeeBps(new Uint8Array(10))).toThrow(
      /too short/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clmm.test.ts`
Expected: FAIL — cannot import `decodeClmmAmmConfigFeeBps`.

- [ ] **Step 3: Write the implementation**

Append to `src/decode/clmm.ts`:

```typescript
import { readU32 } from "./layout.js";

// AmmConfig (repr(packed)): bump u8 @8, index u16 @9, owner @11,
// protocol_fee_rate u32 @43, trade_fee_rate u32 @47 (ppm, denom 1e6).
const TRADE_FEE_RATE = 47;

export const CLMM_AMM_CONFIG_MIN_LEN = TRADE_FEE_RATE + 4;

/** CLMM trade fee in basis points (on-chain rate is parts-per-million). */
export function decodeClmmAmmConfigFeeBps(data: Uint8Array): number {
  if (data.length < CLMM_AMM_CONFIG_MIN_LEN) {
    throw new Error(`ClmmAmmConfig too short: ${data.length}`);
  }
  return readU32(data, TRADE_FEE_RATE) / 100;
}
```

Add `readU32` to the existing `./layout.js` import at the top of the file (merge with the `readI32, readU16, readU128` import).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/clmm.test.ts`
Expected: PASS (5 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/decode/clmm.ts tests/clmm.test.ts
git commit -m "T43: decodeClmmAmmConfigFeeBps — CLMM AmmConfig ppm->bps (own decoder, not CPMM's)"
```

---

### Task 4: `Dex` union + `toClmmSnapshot` adapter

**Files:**
- Modify: `src/types.ts` (additive: `Dex` member + doc comment)
- Modify: `src/decode/clmm.ts` (add adapter)
- Test: `tests/clmm.test.ts` (add cases)

**Interfaces:**
- Consumes: `ClmmPoolState` (Task 2), `WhirlpoolSnapshot`, `PairInfo` from `src/types.js`
- Produces:
  - `interface ClmmSnapshotMeta { poolAddress: string; pair: PairInfo; slot: number; source: string; fetchedAtMs: number; }`
  - `toClmmSnapshot(state: ClmmPoolState, feeBps: number, meta: ClmmSnapshotMeta): WhirlpoolSnapshot`

- [ ] **Step 1: Write the failing test**

Add to `tests/clmm.test.ts`:

```typescript
import { PublicKey } from "@solana/web3.js";
import { toClmmSnapshot } from "../src/decode/clmm.js";
import type { PairInfo } from "../src/types.js";

const PAIR: PairInfo = {
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseDecimals: 9,
  quoteDecimals: 6,
};

function clmmStateWith(mint0: string, mint1: string) {
  return {
    ammConfig: Keypair.generate().publicKey,
    tokenMint0: new PublicKey(mint0),
    tokenMint1: new PublicKey(mint1),
    tokenVault0: Keypair.generate().publicKey,
    tokenVault1: Keypair.generate().publicKey,
    observationKey: Keypair.generate().publicKey,
    mintDecimals0: 9,
    mintDecimals1: 6,
    tickSpacing: 8,
    liquidity: 100n,
    sqrtPriceX64: 7_144_300_000_000_000_000n,
    tickCurrentIndex: -18_000,
  };
}

describe("toClmmSnapshot", () => {
  const meta = {
    poolAddress: "PooLaddr1111111111111111111111111111111111",
    pair: PAIR,
    slot: 42,
    source: "probe",
    fetchedAtMs: 1_700_000_000_000,
  };

  it("produces a whirlpool-kind snapshot tagged dex=raydium-clmm", () => {
    const snap = toClmmSnapshot(clmmStateWith(PAIR.baseMint, PAIR.quoteMint), 25, meta);
    expect(snap.kind).toBe("whirlpool");
    expect(snap.dex).toBe("raydium-clmm");
    expect(snap.sqrtPriceX64).toBe(7_144_300_000_000_000_000n);
    expect(snap.liquidity).toBe(100n);
    expect(snap.tickCurrentIndex).toBe(-18_000);
    expect(snap.feeBps).toBe(25);
    expect(snap.poolAddress).toBe(meta.poolAddress);
    expect(snap.slot).toBe(42);
  });

  it("throws when the pool is oriented mint0=quote (inverted)", () => {
    expect(() =>
      toClmmSnapshot(clmmStateWith(PAIR.quoteMint, PAIR.baseMint), 25, meta),
    ).toThrow(/orientation/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clmm.test.ts`
Expected: FAIL — `toClmmSnapshot` not exported; `"raydium-clmm"` not assignable to `Dex`.

- [ ] **Step 3a: Extend the `Dex` union and doc comment (additive)**

In `src/types.ts`, change the `Dex` type:

```typescript
/** Which venue a snapshot came from. */
export type Dex = "raydium-cpmm" | "orca-whirlpool" | "raydium-clmm";
```

And update the doc comment on the `WhirlpoolSnapshot` interface (the `kind: "whirlpool"` member) so the reused-kind is documented:

```typescript
/**
 * A concentrated-liquidity pool snapshot (Uniswap-V3-family). Despite the
 * name, this `kind` covers BOTH Orca Whirlpool and Raydium CLMM
 * (dex: "raydium-clmm") — both store a Q64.64 sqrt price and are priced
 * identically by detect.ts. The `dex` field distinguishes the venue.
 */
export interface WhirlpoolSnapshot extends SnapshotBase {
  kind: "whirlpool";
```

- [ ] **Step 3b: Add the adapter**

Append to `src/decode/clmm.ts`:

```typescript
import type { PairInfo, WhirlpoolSnapshot } from "../types.js";

export interface ClmmSnapshotMeta {
  poolAddress: string;
  pair: PairInfo;
  slot: number;
  source: string;
  fetchedAtMs: number;
}

/**
 * Adapt a decoded CLMM pool into the shared WhirlpoolSnapshot (kind
 * "whirlpool", dex "raydium-clmm"), so detect.ts consumes it with no
 * changes. Asserts base=mint0 / quote=mint1 orientation; an inverted pool
 * throws rather than being silently transformed (see the design spec).
 */
export function toClmmSnapshot(
  state: ClmmPoolState,
  feeBps: number,
  meta: ClmmSnapshotMeta,
): WhirlpoolSnapshot {
  if (
    state.tokenMint0.toBase58() !== meta.pair.baseMint ||
    state.tokenMint1.toBase58() !== meta.pair.quoteMint
  ) {
    throw new Error(
      `CLMM pool ${meta.poolAddress} orientation mismatch: expected ` +
        `mint0=${meta.pair.baseMint} mint1=${meta.pair.quoteMint}, got ` +
        `mint0=${state.tokenMint0.toBase58()} mint1=${state.tokenMint1.toBase58()}`,
    );
  }
  return {
    kind: "whirlpool",
    dex: "raydium-clmm",
    poolAddress: meta.poolAddress,
    pair: meta.pair,
    fetchedAtMs: meta.fetchedAtMs,
    slot: meta.slot,
    source: meta.source,
    sqrtPriceX64: state.sqrtPriceX64,
    liquidity: state.liquidity,
    tickCurrentIndex: state.tickCurrentIndex,
    feeBps,
  };
}
```

- [ ] **Step 4: Run test to verify it passes, plus typecheck**

Run: `npx vitest run tests/clmm.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests in the file); typecheck clean (confirms the additive `Dex` change broke nothing).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/decode/clmm.ts tests/clmm.test.ts
git commit -m "T44: raydium-clmm Dex member + toClmmSnapshot adapter (Approach A, orientation-checked)"
```

---

### Task 5: Detection round-trip (proves zero-detect-change wiring)

**Files:**
- Test: `tests/clmm.test.ts` (add integration cases)

**Interfaces:**
- Consumes: `detect` from `src/detect.js`, `toClmmSnapshot` (Task 4), `WhirlpoolSnapshot`

This task adds no `src/` code. It proves the design's central claim: a CLMM snapshot drives `detect()` against an Orca snapshot with no changes to `detect.ts`.

- [ ] **Step 1: Write the test**

Add to `tests/clmm.test.ts`:

```typescript
import { detect } from "../src/detect.js";
import type { WhirlpoolSnapshot } from "../src/types.js";

function orcaSnap(sqrtPriceX64: bigint): WhirlpoolSnapshot {
  return {
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: "OrcaPooL111111111111111111111111111111111",
    pair: PAIR,
    fetchedAtMs: 1_700_000_000_000,
    slot: 42,
    source: "test",
    sqrtPriceX64,
    liquidity: 1_000_000n,
    tickCurrentIndex: 0,
    feeBps: 4,
  };
}

describe("CLMM snapshot drives detect() with no detect.ts change", () => {
  const meta = {
    poolAddress: "PooLaddr1111111111111111111111111111111111",
    pair: PAIR,
    slot: 42,
    source: "probe",
    fetchedAtMs: 1_700_000_000_000,
  };
  // ~150 USDC/SOL raw price; CLMM cheaper than Orca -> arb exists.
  const cheapClmm = toClmmSnapshot(
    { ...clmmStateWith(PAIR.baseMint, PAIR.quoteMint), sqrtPriceX64: 7_100_000_000_000_000_000n },
    4,
    meta,
  );
  const params = {
    tradeSizeQuote: 100_000_000n, // 100 USDC
    minProfitThresholdQuote: 1n,
    slippageToleranceBps: 10,
    estTxFeeQuote: 0n,
  };

  it("flags an opportunity when CLMM and Orca prices diverge", () => {
    const richOrca = orcaSnap(7_400_000_000_000_000_000n); // higher price
    const d = detect(cheapClmm, richOrca, params);
    expect(d.decision).toBe("opportunity");
  });

  it("no opportunity when prices are aligned", () => {
    const alignedOrca = orcaSnap(7_100_000_000_000_000_000n);
    const d = detect(cheapClmm, alignedOrca, params);
    expect(d.decision).toBe("no-opportunity");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/clmm.test.ts`
Expected: PASS. (If the divergence case fails, widen the sqrtPrice gap — it must clear fees+slippage; do NOT weaken the threshold, per docs/NEVER_DO.md.)

- [ ] **Step 3: Run the full suite + typecheck (no regressions)**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all existing tests still pass; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add tests/clmm.test.ts
git commit -m "T45: detection round-trip proving CLMM snapshot works with zero detect.ts change"
```

---

### Task 6: Read-only mainnet probe + live verification + orientation report

**Files:**
- Create: `scripts/probe-mainnet-clmm-pools.ts`

**Interfaces:**
- Consumes: `decodeClmmPool` (Task 2), `decodeClmmAmmConfigFeeBps` (Task 3), `sqrtPriceX64ToPrice` from `src/math/whirlpool.js`

This is the LIVE half of dual-source verification: decode a real mainnet CLMM pool + its AmmConfig with our decoders and sanity-assert. Read-only — no keypair, sends nothing, cannot disturb the running shadow. Mirrors `scripts/probe-mainnet-pools.ts`.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-mainnet-clmm-pools.ts`:

```typescript
/**
 * READ-ONLY mainnet probe for the deepest Raydium CLMM SOL/USDC pool.
 * Decodes the pool + its AmmConfig with OUR decoders (live half of the
 * dual-source offset verification) and reports pool orientation. Sends
 * nothing; needs no keypair; does not touch the running shadow.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "../src/decode/clmm.js";
import { sqrtPriceX64ToPrice } from "../src/math/whirlpool.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const raydium = await Raydium.load({ connection, disableLoadToken: false });
  const usdc = raydium.token.tokenList.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("USDC not found in Raydium token list");
  console.log(`[probe] USDC mint per Raydium list: ${usdc.address}`);

  const clmmPools: Array<{ id: string; tvl: number }> = [];
  for (let page = 1; page <= 20; page++) {
    const pools = await raydium.api.fetchPoolByMints({
      mint1: SOL_MINT,
      mint2: usdc.address,
      page,
    });
    clmmPools.push(
      ...(pools.data ?? [])
        .filter((p) => p.programId === CLMM_PROGRAM)
        .map((p) => ({ id: p.id, tvl: p.tvl ?? 0 })),
    );
    if (!pools.hasNextPage) break;
  }
  clmmPools.sort((a, b) => b.tvl - a.tvl);
  if (clmmPools.length === 0) throw new Error("no Raydium CLMM SOL/USDC pool found");
  console.log(
    `[probe] top CLMM SOL/USDC pools by TVL:`,
    clmmPools.slice(0, 5).map((p) => `${p.id} ($${Math.round(p.tvl)})`),
  );

  const selected = clmmPools[0]!;
  const poolAcc = await connection.getAccountInfo(new PublicKey(selected.id));
  if (!poolAcc) throw new Error(`pool ${selected.id} account not found`);
  const state = decodeClmmPool(poolAcc.data);

  const cfgAcc = await connection.getAccountInfo(state.ammConfig);
  if (!cfgAcc) throw new Error(`amm_config ${state.ammConfig.toBase58()} not found`);
  const feeBps = decodeClmmAmmConfigFeeBps(cfgAcc.data);

  const solIsMint0 = state.tokenMint0.toBase58() === SOL_MINT;
  const inverted = !solIsMint0;
  const price = sqrtPriceX64ToPrice(
    state.sqrtPriceX64,
    solIsMint0 ? state.mintDecimals0 : state.mintDecimals1,
    solIsMint0 ? state.mintDecimals1 : state.mintDecimals0,
  );

  console.log(`\n=== LIVE CLMM DECODE (verification) ===`);
  console.log(`pool:        ${selected.id}  ($${Math.round(selected.tvl)} TVL)`);
  console.log(`amm_config:  ${state.ammConfig.toBase58()}`);
  console.log(`mint0:       ${state.tokenMint0.toBase58()} (dec ${state.mintDecimals0})`);
  console.log(`mint1:       ${state.tokenMint1.toBase58()} (dec ${state.mintDecimals1})`);
  console.log(`tickSpacing: ${state.tickSpacing}   tickCurrent: ${state.tickCurrentIndex}`);
  console.log(`feeBps:      ${feeBps}`);
  console.log(`sqrtPriceX64: ${state.sqrtPriceX64}`);
  console.log(`derived SOL/USDC price: ~${price.toFixed(2)}`);
  console.log(`\n>>> ORIENTATION: ${inverted ? "INVERTED (SOL is mint_1)" : "NORMAL (SOL is mint_0)"} <<<`);

  // Sanity gates — throw loudly if any offset is wrong.
  const mints = new Set([state.tokenMint0.toBase58(), state.tokenMint1.toBase58()]);
  if (!mints.has(SOL_MINT) || !mints.has(usdc.address)) {
    throw new Error("decoded mints are not SOL/USDC — offsets likely wrong");
  }
  if (!(price > 20 && price < 2000)) {
    throw new Error(`derived price ${price} outside sane SOL/USDC band — check offsets`);
  }
  if (!(feeBps > 0 && feeBps <= 100)) {
    throw new Error(`feeBps ${feeBps} outside sane CLMM tier band — check AmmConfig offset`);
  }
  console.log(`\n[probe] all sanity gates passed — offsets verified against live data.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the probe against mainnet**

Run: `npx tsx scripts/probe-mainnet-clmm-pools.ts`
Expected: prints the selected pool, a decoded SOL/USDC price in a sane band, feeBps in a known tier, the ORIENTATION line, and `all sanity gates passed`. If it throws on a sanity gate, an offset is wrong — recheck against the pinned source before proceeding.

- [ ] **Step 3: Record the pinned source commit + report orientation to owner**

Edit the `<PINNED_COMMIT>` placeholder in `src/decode/clmm.ts`'s header to the exact raydium-clmm commit hash the offsets were verified against. Then **report to the owner**: the selected pool address, its TVL, feeBps, and explicitly whether it is NORMAL or INVERTED (SOL as mint_1). If INVERTED, stop and confirm the follow-up handling approach before wiring a polling source.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-mainnet-clmm-pools.ts src/decode/clmm.ts
git commit -m "T46: read-only CLMM mainnet probe (live offset verification + orientation report)"
```

---

## Self-Review

**Spec coverage:**
- decode/clmm.ts pool decoder → Task 2 ✓
- AmmConfig fee decoder (own, not CPMM's) → Task 3 ✓
- Math reuse (whirlpool.ts unchanged) → Tasks 5 & 6 consume it; no edit ✓
- Approach A snapshot typing (kind whirlpool, dex raydium-clmm, doc comment) → Task 4 ✓
- Orientation assertion + owner report → Task 4 (assert) + Task 6 (report) ✓
- Dual-source offset verification → source (Task 2/3 offsets + header) + live (Task 6) ✓
- Tests: decode, fee, adapter, detection round-trip → Tasks 2,3,4,5 ✓
- Probe/capture script → Task 6 ✓
- Isolation (no orcaOrcaPolling/whirlpool/detect edits) → only additive layout.ts + types.ts touched; verified in Task 4 typecheck and Task 5 full-suite run ✓
- Forward tx-builder notes → in the spec, out of plan scope by design ✓

**Placeholder scan:** `<PINNED_COMMIT>` in Task 2 is intentional and resolved in Task 6 Step 3 (recording the real commit is an explicit step), not an unfilled plan gap. No other TBD/TODO.

**Type consistency:** `ClmmPoolState` fields (Task 2) match adapter usage (Task 4); `toClmmSnapshot(state, feeBps, meta)` signature consistent across Tasks 4–5; `decodeClmmAmmConfigFeeBps` name consistent Tasks 3 & 6; `readU32` name consistent Tasks 1 & 3.
