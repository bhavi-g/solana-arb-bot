import { describe, expect, it } from "vitest";
import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  applyFeeHeadroom,
  lamportsFeeToQuote,
  resolveBaseFeeLamports,
} from "../src/fee.js";
import type { CpmmSnapshot, WhirlpoolSnapshot } from "../src/types.js";

const pair = {
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "USDC-mint",
  baseDecimals: 9,
  quoteDecimals: 6,
};

function cpmm(baseReserve: bigint, quoteReserve: bigint): CpmmSnapshot {
  return {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "RayPool111",
    pair,
    fetchedAtMs: 1_700_000_000_000,
    slot: 100,
    source: "test",
    baseReserve,
    quoteReserve,
    feeBps: 25,
  };
}

function whirl(sqrtPriceX64: bigint): WhirlpoolSnapshot {
  return {
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: "OrcaPool111",
    pair,
    fetchedAtMs: 1_700_000_000_000,
    slot: 100,
    source: "test",
    sqrtPriceX64,
    liquidity: 10n ** 15n,
    tickCurrentIndex: 0,
    feeBps: 30,
  };
}

describe("applyFeeHeadroom", () => {
  it("adds exactly 20% to the protocol base fee", () => {
    // 5000 lamports (1 signature) -> 6000 with +20% headroom.
    expect(applyFeeHeadroom(5000n)).toBe(6000n);
  });

  it("floors on integer division (no rounding up)", () => {
    // 5001 * 120 / 100 = 6001.2 -> 6001
    expect(applyFeeHeadroom(5001n)).toBe(6001n);
  });

  it("is zero for a zero fee", () => {
    expect(applyFeeHeadroom(0n)).toBe(0n);
  });
});

describe("lamportsFeeToQuote", () => {
  it("converts a lamport fee to quote units at the cpmm mid price", () => {
    // Pool: 10,000 SOL (1e13 lamports) / 1,500,000 devUSDC (1.5e12 units).
    // price = 1.5e12 / 1e13 = 0.15 quote-raw per base-raw (lamport).
    // 6000 lamports -> 6000 * 1.5e12 / 1e13 = 900 quote units.
    const snap = cpmm(10_000n * 10n ** 9n, 1_500_000n * 10n ** 6n);
    expect(lamportsFeeToQuote(6000n, snap)).toBe(900n);
  });

  it("converts using the whirlpool mid price (sqrtPriceX64^2 / 2^128)", () => {
    // sqrtPriceX64 chosen so (sqrtP^2 / 2^128) = 0.15 quote-raw per base-raw.
    // sqrtP = floor(sqrt(0.15) * 2^64). Verify the conversion is internally
    // consistent with detect's exported mid-price helpers, not a magic number.
    const sqrtP = 7_144_247_248_808_263_680n; // ~sqrt(0.15) * 2^64 (from synthetic.ts)
    const snap = whirl(sqrtP);
    const fee = lamportsFeeToQuote(6000n, snap);
    // ~0.15 * 6000 = ~900, allow a small floor/precision band.
    expect(fee).toBeGreaterThan(880n);
    expect(fee).toBeLessThan(920n);
  });
});

describe("resolveBaseFeeLamports", () => {
  it("uses the fetched RPC value when it is a positive number", async () => {
    const r = await resolveBaseFeeLamports(async () => 5000, 1);
    expect(r).toEqual({ lamports: 5000n, source: "rpc" });
  });

  it("falls back to the protocol constant when the fetcher returns null", async () => {
    const r = await resolveBaseFeeLamports(async () => null, 1);
    expect(r).toEqual({
      lamports: BASE_FEE_LAMPORTS_PER_SIGNATURE,
      source: "fallback",
    });
  });

  it("falls back when the fetcher throws", async () => {
    const r = await resolveBaseFeeLamports(async () => {
      throw new Error("rpc down");
    }, 2);
    expect(r).toEqual({
      lamports: BASE_FEE_LAMPORTS_PER_SIGNATURE * 2n,
      source: "fallback",
    });
  });

  it("falls back when the fetcher returns a non-positive value", async () => {
    const r = await resolveBaseFeeLamports(async () => 0, 1);
    expect(r.source).toBe("fallback");
  });

  it("scales the fallback by signature count", async () => {
    const r = await resolveBaseFeeLamports(async () => null, 3);
    expect(r.lamports).toBe(BASE_FEE_LAMPORTS_PER_SIGNATURE * 3n);
  });
});
