import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildClmmSwapV2Ix,
  CLMM_MAX_SQRT_PRICE_X64,
  CLMM_MIN_SQRT_PRICE_X64,
  CLMM_SWAP_V2_DISCRIMINATOR,
  clmmTickArrayPda,
  clmmTickArrayStartIndex,
  tickArrayBitmapExtensionPda,
} from "../src/txbuilder/raydiumClmm.js";
import { TOKEN_PROGRAM_ID } from "../src/txbuilder/index.js";

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

  // The on-chain require! (raydium-clmm swap.rs) uses STRICT inequalities
  // against these bounds (verified against source AND live via mainnet
  // simulation error 6011 SqrtPriceLimitOverflow), so the exact boundary
  // value is always rejected — the client must submit MIN+1 / MAX-1.
  it("sets sqrt_price_limit_x64 to MIN+1 for inputIsToken0=true, MAX-1 for false", () => {
    const t0 = buildClmmSwapV2Ix({ ...base, inputIsToken0: true });
    const lo0 = t0.data.readBigUInt64LE(24);
    const hi0 = t0.data.readBigUInt64LE(32);
    expect((hi0 << 64n) | lo0).toBe(CLMM_MIN_SQRT_PRICE_X64 + 1n);

    const t1 = buildClmmSwapV2Ix({ ...base, inputIsToken0: false });
    const lo1 = t1.data.readBigUInt64LE(24);
    const hi1 = t1.data.readBigUInt64LE(32);
    expect((hi1 << 64n) | lo1).toBe(CLMM_MAX_SQRT_PRICE_X64 - 1n);
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
