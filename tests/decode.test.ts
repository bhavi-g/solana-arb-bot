import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  decodeAmmConfigFeeBps,
  decodeRaydiumCpmmPool,
  decodeTokenAccountAmount,
  RAYDIUM_POOL_STATE_MIN_LEN,
} from "../src/decode/raydiumCpmm.js";
import {
  decodeWhirlpool,
  WHIRLPOOL_MIN_LEN,
} from "../src/decode/orcaWhirlpool.js";

function writeU64(buf: Uint8Array, offset: number, v: bigint) {
  for (let i = 0; i < 8; i++) buf[offset + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}
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

describe("decodeRaydiumCpmmPool", () => {
  it("extracts vaults, mints, decimals and accrued fees at verified offsets", () => {
    const buf = new Uint8Array(RAYDIUM_POOL_STATE_MIN_LEN + 224);
    const ammConfig = Keypair.generate().publicKey;
    const vault0 = Keypair.generate().publicKey;
    const vault1 = Keypair.generate().publicKey;
    const mint0 = Keypair.generate().publicKey;
    const mint1 = Keypair.generate().publicKey;
    buf.set(ammConfig.toBytes(), 8);
    buf.set(vault0.toBytes(), 72);
    buf.set(vault1.toBytes(), 104);
    buf.set(mint0.toBytes(), 168);
    buf.set(mint1.toBytes(), 200);
    buf[331] = 9; // mint0 decimals
    buf[332] = 6; // mint1 decimals
    writeU64(buf, 341, 1_000n); // protocol fees 0
    writeU64(buf, 349, 2_000n); // protocol fees 1
    writeU64(buf, 357, 300n); // fund fees 0
    writeU64(buf, 365, 400n); // fund fees 1
    writeU64(buf, 397, 5n); // creator fees 0
    writeU64(buf, 405, 6n); // creator fees 1

    const s = decodeRaydiumCpmmPool(buf);
    expect(s.ammConfig.equals(ammConfig)).toBe(true);
    expect(s.token0Vault.equals(vault0)).toBe(true);
    expect(s.token1Vault.equals(vault1)).toBe(true);
    expect(s.token0Mint.equals(mint0)).toBe(true);
    expect(s.token1Mint.equals(mint1)).toBe(true);
    expect(s.mint0Decimals).toBe(9);
    expect(s.mint1Decimals).toBe(6);
    expect(s.feesToken0).toBe(1_305n);
    expect(s.feesToken1).toBe(2_406n);
  });

  it("rejects truncated data", () => {
    expect(() => decodeRaydiumCpmmPool(new Uint8Array(100))).toThrow(/short/);
  });
});

describe("decodeAmmConfigFeeBps", () => {
  it("converts parts-per-million trade fee to bps (2500 ppm = 25 bps)", () => {
    const buf = new Uint8Array(256);
    writeU64(buf, 12, 2_500n);
    expect(decodeAmmConfigFeeBps(buf)).toBe(25);
  });
});

describe("decodeTokenAccountAmount", () => {
  it("reads the u64 amount at offset 64", () => {
    const buf = new Uint8Array(165);
    writeU64(buf, 64, 123_456_789_012n);
    expect(decodeTokenAccountAmount(buf)).toBe(123_456_789_012n);
  });
});

describe("decodeWhirlpool", () => {
  it("extracts sqrtPrice, liquidity, tick, fee and mints at verified offsets", () => {
    const buf = new Uint8Array(WHIRLPOOL_MIN_LEN + 448);
    const mintA = Keypair.generate().publicKey;
    const mintB = Keypair.generate().publicKey;
    writeU16(buf, 45, 3000); // fee_rate: 3000 hundredths-of-bps = 30 bps
    writeU128(buf, 49, 987_654_321n); // liquidity
    writeU128(buf, 65, 7_144_247_248_808_263_680n); // sqrt_price
    writeI32(buf, 81, -18_975); // tick_current_index
    buf.set(mintA.toBytes(), 101);
    buf.set(mintB.toBytes(), 181);

    const s = decodeWhirlpool(buf);
    expect(s.feeBps).toBe(30);
    expect(s.liquidity).toBe(987_654_321n);
    expect(s.sqrtPriceX64).toBe(7_144_247_248_808_263_680n);
    expect(s.tickCurrentIndex).toBe(-18_975);
    expect(s.tokenMintA.equals(mintA)).toBe(true);
    expect(s.tokenMintB.equals(mintB)).toBe(true);
  });

  it("rejects truncated data", () => {
    expect(() => decodeWhirlpool(new Uint8Array(64))).toThrow(/short/);
  });
});
