import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  buildTwoWhirlpoolArbTransaction,
  type TwoWhirlpoolBuildContext,
} from "../src/txbuilder/twoWhirlpool.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { Opportunity } from "../src/types.js";

const kp = () => Keypair.generate().publicKey;
const baseMint = kp(); // SOL
const quoteMint = kp(); // USDC
const poolA = kp();
const poolB = kp();
const programId = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

function state(): WhirlpoolState {
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

function ctx(payer: Keypair | PublicKey): TwoWhirlpoolBuildContext {
  return {
    payer,
    recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    pair: {
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseDecimals: 9,
      quoteDecimals: 6,
    },
    whirlpoolA: { programId, poolAddress: poolA, state: state(), tickCurrentIndex: -18_975 },
    whirlpoolB: { programId, poolAddress: poolB, state: state(), tickCurrentIndex: -18_975 },
  };
}

// Buy SOL on pool A, sell on pool B.
const opp: Opportunity = {
  decision: "opportunity",
  direction: {
    buyOn: "orca-whirlpool",
    sellOn: "orca-whirlpool",
    buyPoolAddress: poolA.toBase58(),
    sellPoolAddress: poolB.toBase58(),
  },
  gapBps: -300,
  quoteIn: 100_000_000n,
  baseOut: 680_000_000n,
  quoteOut: 100_250_000n,
  estNetProfit: 250_000n,
  minProfitThreshold: 10_000n,
};

describe("buildTwoWhirlpoolArbTransaction", () => {
  it("emits two whirlpool legs: buy (B→A) on the buy pool, sell (A→B) on the sell pool", () => {
    const payer = Keypair.generate();
    const tx = buildTwoWhirlpoolArbTransaction({ ...ctx(payer), payer }, opp);
    expect(tx.message.compiledInstructions.length).toBe(2);

    const keys = tx.message.staticAccountKeys;
    const buy = tx.message.compiledInstructions[0]!;
    const sell = tx.message.compiledInstructions[1]!;

    // whirlpool account is key index 2 of each swap ix
    expect(keys[buy.accountKeyIndexes[2]!]!.equals(poolA)).toBe(true);
    expect(keys[sell.accountKeyIndexes[2]!]!.equals(poolB)).toBe(true);

    // buy leg: input = quoteIn (USDC), aToB = false (B→A, buying SOL)
    const buyData = Buffer.from(buy.data);
    expect(buyData.readBigUInt64LE(8)).toBe(100_000_000n);
    expect(buyData.readBigUInt64LE(16)).toBe(680_000_000n); // min SOL out
    expect(buyData.readUInt8(41)).toBe(0); // aToB false

    // sell leg: input = baseOut (SOL), aToB = true, min out = quoteIn + threshold
    const sellData = Buffer.from(sell.data);
    expect(sellData.readBigUInt64LE(8)).toBe(680_000_000n);
    expect(sellData.readBigUInt64LE(16)).toBe(100_010_000n);
    expect(sellData.readUInt8(41)).toBe(1); // aToB true

    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true); // signed
  });

  it("reverses which pool is buy vs sell per the opportunity direction", () => {
    const payer = Keypair.generate();
    const reversed: Opportunity = {
      ...opp,
      direction: {
        ...opp.direction,
        buyPoolAddress: poolB.toBase58(),
        sellPoolAddress: poolA.toBase58(),
      },
    };
    const tx = buildTwoWhirlpoolArbTransaction({ ...ctx(payer), payer }, reversed);
    const keys = tx.message.staticAccountKeys;
    const buy = tx.message.compiledInstructions[0]!;
    expect(keys[buy.accountKeyIndexes[2]!]!.equals(poolB)).toBe(true);
  });

  it("prepends a compute-budget instruction when a CU limit is given", () => {
    const payer = Keypair.generate();
    const tx = buildTwoWhirlpoolArbTransaction({ ...ctx(payer), payer }, opp, 240_000);
    expect(tx.message.compiledInstructions.length).toBe(3);
    const progIdx = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(tx.message.staticAccountKeys[progIdx]!.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
  });

  it("builds UNSIGNED with a PublicKey payer (shadow-mode surrogate)", () => {
    const surrogate = kp();
    const tx = buildTwoWhirlpoolArbTransaction(ctx(surrogate), opp);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(surrogate)).toBe(true);
  });

  it("throws if the opportunity's buy pool matches neither configured pool", () => {
    const payer = Keypair.generate();
    const bad: Opportunity = {
      ...opp,
      direction: { ...opp.direction, buyPoolAddress: kp().toBase58() },
    };
    expect(() =>
      buildTwoWhirlpoolArbTransaction({ ...ctx(payer), payer }, bad),
    ).toThrow(/buy pool/i);
  });
});
