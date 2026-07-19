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
