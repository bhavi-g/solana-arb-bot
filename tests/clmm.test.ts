import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  decodeClmmPool,
  CLMM_POOL_STATE_MIN_LEN,
  decodeClmmAmmConfigFeeBps,
  CLMM_AMM_CONFIG_MIN_LEN,
  toClmmSnapshot,
} from "../src/decode/clmm.js";
import type { PairInfo, WhirlpoolSnapshot } from "../src/types.js";
import { detect } from "../src/detect.js";

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
function writeU32(buf: Uint8Array, offset: number, v: number) {
  new DataView(buf.buffer, buf.byteOffset + offset, 4).setUint32(0, v, true);
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
