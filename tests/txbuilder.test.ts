import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCpmmSwapBaseInputIx,
  cpmmAuthority,
  SWAP_BASE_INPUT_DISCRIMINATOR,
} from "../src/txbuilder/raydiumCpmm.js";
import {
  buildWhirlpoolSwapIx,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  tickArrayStartIndex,
  WHIRLPOOL_SWAP_DISCRIMINATOR,
} from "../src/txbuilder/orcaWhirlpool.js";
import {
  associatedTokenAddress,
  buildArbTransaction,
  TOKEN_PROGRAM_ID,
  type ArbBuildContext,
} from "../src/txbuilder/index.js";
import type { Opportunity } from "../src/types.js";

const kp = () => Keypair.generate().publicKey;

describe("anchor discriminators", () => {
  it("match sha256(global:<name>)[0..8]", () => {
    expect(Buffer.from(SWAP_BASE_INPUT_DISCRIMINATOR).toString("hex")).toBe(
      createHash("sha256").update("global:swap_base_input").digest().subarray(0, 8).toString("hex"),
    );
    expect(Buffer.from(WHIRLPOOL_SWAP_DISCRIMINATOR).toString("hex")).toBe(
      createHash("sha256").update("global:swap").digest().subarray(0, 8).toString("hex"),
    );
  });
});

describe("buildCpmmSwapBaseInputIx", () => {
  it("encodes amounts LE after the discriminator and orders the 13 accounts", () => {
    const programId = kp();
    const payer = kp();
    const ix = buildCpmmSwapBaseInputIx({
      programId,
      payer,
      ammConfig: kp(),
      poolState: kp(),
      inputTokenAccount: kp(),
      outputTokenAccount: kp(),
      inputVault: kp(),
      outputVault: kp(),
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      inputMint: kp(),
      outputMint: kp(),
      observationState: kp(),
      amountIn: 10_000_000n,
      minimumAmountOut: 68_000_000n,
    });
    expect(ix.keys.length).toBe(13);
    expect(ix.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(cpmmAuthority(programId))).toBe(true);
    expect(ix.keys[3]!.isWritable).toBe(true); // pool_state
    expect(ix.keys[12]!.isWritable).toBe(true); // observation_state
    expect(ix.data.readBigUInt64LE(8)).toBe(10_000_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(68_000_000n);
  });
});

describe("buildWhirlpoolSwapIx", () => {
  const base = {
    programId: kp(),
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: kp(),
    whirlpool: kp(),
    tokenOwnerAccountA: kp(),
    tokenVaultA: kp(),
    tokenOwnerAccountB: kp(),
    tokenVaultB: kp(),
    tickCurrentIndex: -18_975,
    tickSpacing: 64,
    amount: 68_000_000n,
    otherAmountThreshold: 10_010_000n,
  };

  it("encodes args in order with direction-correct sqrt price limit", () => {
    const ix = buildWhirlpoolSwapIx({ ...base, aToB: true });
    expect(ix.data.readBigUInt64LE(8)).toBe(68_000_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(10_010_000n);
    const lo = ix.data.readBigUInt64LE(24);
    const hi = ix.data.readBigUInt64LE(32);
    expect((hi << 64n) | lo).toBe(MIN_SQRT_PRICE);
    expect(ix.data.readUInt8(40)).toBe(1); // amount_specified_is_input
    expect(ix.data.readUInt8(41)).toBe(1); // a_to_b

    const bToA = buildWhirlpoolSwapIx({ ...base, aToB: false });
    const lo2 = bToA.data.readBigUInt64LE(24);
    const hi2 = bToA.data.readBigUInt64LE(32);
    expect((hi2 << 64n) | lo2).toBe(MAX_SQRT_PRICE);
    expect(bToA.data.readUInt8(41)).toBe(0);
  });

  it("walks tick arrays downward for aToB and upward for bToA", () => {
    const aToB = buildWhirlpoolSwapIx({ ...base, aToB: true });
    const bToA = buildWhirlpoolSwapIx({ ...base, aToB: false });
    // arrays occupy keys 7..9; same start, opposite walk => keys 8/9 differ
    expect(aToB.keys[7]!.pubkey.equals(bToA.keys[7]!.pubkey)).toBe(true);
    expect(aToB.keys[8]!.pubkey.equals(bToA.keys[8]!.pubkey)).toBe(false);
    expect(ixHasElevenKeys(aToB)).toBe(true);
  });

  function ixHasElevenKeys(ix: { keys: unknown[] }) {
    return ix.keys.length === 11;
  }

  it("tickArrayStartIndex floors toward negative infinity", () => {
    // 64 * 88 = 5632 ticks per array
    expect(tickArrayStartIndex(0, 64)).toBe(0);
    expect(tickArrayStartIndex(5631, 64)).toBe(0);
    expect(tickArrayStartIndex(5632, 64)).toBe(5632);
    expect(tickArrayStartIndex(-1, 64)).toBe(-5632);
    expect(tickArrayStartIndex(-18_975, 64)).toBe(-22_528);
  });
});

describe("buildArbTransaction (one atomic tx, both legs)", () => {
  function ctx(): { ctx: ArbBuildContext; payer: Keypair } {
    const payer = Keypair.generate();
    const baseMint = kp();
    const quoteMint = kp();
    return {
      payer,
      ctx: {
        payer,
        recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
        pair: {
          baseMint: baseMint.toBase58(),
          quoteMint: quoteMint.toBase58(),
          baseDecimals: 9,
          quoteDecimals: 6,
        },
        raydium: {
          programId: kp(),
          poolAddress: kp(),
          state: {
            ammConfig: kp(),
            token0Vault: kp(),
            token1Vault: kp(),
            token0Mint: baseMint,
            token1Mint: quoteMint,
            token0Program: TOKEN_PROGRAM_ID,
            token1Program: TOKEN_PROGRAM_ID,
            observationKey: kp(),
            mint0Decimals: 9,
            mint1Decimals: 6,
            feesToken0: 0n,
            feesToken1: 0n,
          },
        },
        whirlpool: {
          programId: kp(),
          poolAddress: kp(),
          state: {
            sqrtPriceX64: 7_144_247_248_808_263_680n,
            liquidity: 1n,
            tickCurrentIndex: -18_975,
            tickSpacing: 64,
            feeBps: 30,
            tokenMintA: baseMint,
            tokenMintB: quoteMint,
            tokenVaultA: kp(),
            tokenVaultB: kp(),
          },
          tickCurrentIndex: -18_975,
        },
      },
    };
  }

  const opp: Opportunity = {
    decision: "opportunity",
    direction: { buyOn: "raydium-cpmm", sellOn: "orca-whirlpool" },
    gapBps: -300,
    quoteIn: 10_000_000n,
    baseOut: 68_000_000n,
    quoteOut: 10_250_000n,
    estNetProfit: 250_000n,
    minProfitThreshold: 10_000n,
  };

  it("contains exactly the two legs (buy first), signed by the payer", () => {
    const { ctx: c, payer } = ctx();
    const tx = buildArbTransaction(c, opp);
    expect(tx.message.compiledInstructions.length).toBe(2);
    // buy on cpmm -> first instruction targets the raydium program
    const progIdx0 = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(
      tx.message.staticAccountKeys[progIdx0]!.equals(c.raydium.programId),
    ).toBe(true);
    expect(tx.signatures.length).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.equals(payer.publicKey)).toBe(true);
    // it serializes (fully signed, valid message)
    expect(tx.serialize().length).toBeGreaterThan(0);
  });

  it("prepends a compute-budget instruction when a CU limit is given", () => {
    const { ctx: c } = ctx();
    const tx = buildArbTransaction(c, opp, 115_000);
    expect(tx.message.compiledInstructions.length).toBe(3);
    const progIdx = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(tx.message.staticAccountKeys[progIdx]!.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
  });

  it("reverses leg order for the opposite direction", () => {
    const { ctx: c } = ctx();
    const reversed: Opportunity = {
      ...opp,
      direction: { buyOn: "orca-whirlpool", sellOn: "raydium-cpmm" },
    };
    const tx = buildArbTransaction(c, reversed);
    const progIdx0 = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(
      tx.message.staticAccountKeys[progIdx0]!.equals(c.whirlpool.programId),
    ).toBe(true);
  });

  it("sell leg enforces quoteIn + minProfitThreshold as minimum out (profit is atomic)", () => {
    const { ctx: c } = ctx();
    const tx = buildArbTransaction(c, opp);
    // second instruction is the whirlpool sell leg
    const sell = tx.message.compiledInstructions[1]!;
    const data = Buffer.from(sell.data);
    expect(data.readBigUInt64LE(16)).toBe(10_010_000n); // quoteIn + threshold
  });

  it("derives distinct ATAs for base and quote owned by the payer", () => {
    const owner = kp();
    const m1 = kp();
    const m2 = kp();
    const a1 = associatedTokenAddress(owner, m1);
    const a2 = associatedTokenAddress(owner, m2);
    expect(a1.equals(a2)).toBe(false);
    expect(PublicKey.isOnCurve(a1.toBytes())).toBe(false);
  });
});
