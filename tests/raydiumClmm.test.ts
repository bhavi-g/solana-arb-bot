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
