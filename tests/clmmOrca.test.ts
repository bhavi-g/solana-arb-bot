import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "../src/txbuilder/clmmOrca.js";
import type { ClmmPoolState } from "../src/decode/clmm.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { Opportunity } from "../src/types.js";

const kp = () => Keypair.generate().publicKey;
const baseMint = kp(); // SOL  = mint0 / whirlpool A
const quoteMint = kp(); // USDC = mint1 / whirlpool B
const clmmPool = kp();
const orcaPool = kp();
const clmmProgram = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const orcaProgram = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const clmmVault0 = kp(); // SOL vault
const clmmVault1 = kp(); // USDC vault

function clmmState(): ClmmPoolState {
  return {
    ammConfig: kp(),
    tokenMint0: baseMint,
    tokenMint1: quoteMint,
    tokenVault0: clmmVault0,
    tokenVault1: clmmVault1,
    observationKey: kp(),
    mintDecimals0: 9,
    mintDecimals1: 6,
    tickSpacing: 4,
    liquidity: 10n ** 15n,
    sqrtPriceX64: 7_144_247_248_808_263_680n,
    tickCurrentIndex: -25_696,
  };
}

function whirlState(): WhirlpoolState {
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

function ctx(payer: Keypair | PublicKey): ClmmOrcaBuildContext {
  return {
    payer,
    recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    pair: {
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseDecimals: 9,
      quoteDecimals: 6,
    },
    clmm: { programId: clmmProgram, poolAddress: clmmPool, state: clmmState(), tickCurrentIndex: -25_696 },
    whirlpool: { programId: orcaProgram, poolAddress: orcaPool, state: whirlState(), tickCurrentIndex: -18_975 },
  };
}

// Buy SOL on CLMM, sell on Orca.
const buyOnClmm: Opportunity = {
  decision: "opportunity",
  direction: { buyOn: "raydium-clmm", sellOn: "orca-whirlpool" },
  gapBps: -300,
  quoteIn: 100_000_000n,
  baseOut: 680_000_000n,
  quoteOut: 100_250_000n,
  estNetProfit: 250_000n,
  minProfitThreshold: 10_000n,
};

// CLMM swap_v2 ix layout: pool_state = account index 2, input_vault = index 5;
// data: amount@8, otherAmountThreshold@16 (both u64 LE).
// Whirlpool swap ix: whirlpool = account index 2; data: amount@8, threshold@16,
// aToB byte @41.
describe("buildClmmOrcaArbTransaction", () => {
  it("buy on CLMM / sell on Orca: CLMM leg inputs USDC (vault1), Orca leg sells SOL (aToB=true)", () => {
    const payer = Keypair.generate();
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, buyOnClmm);
    expect(tx.message.compiledInstructions.length).toBe(2);

    const keys = tx.message.staticAccountKeys;
    const clmm = tx.message.compiledInstructions[0]!; // buy leg first
    const orca = tx.message.compiledInstructions[1]!;

    // CLMM leg is on the CLMM pool, buying SOL → input is USDC (mint1) → input_vault = vault1
    expect(keys[clmm.accountKeyIndexes[2]!]!.equals(clmmPool)).toBe(true);
    expect(keys[clmm.accountKeyIndexes[5]!]!.equals(clmmVault1)).toBe(true);
    const clmmData = Buffer.from(clmm.data);
    expect(clmmData.readBigUInt64LE(8)).toBe(100_000_000n); // amount = quoteIn (USDC)
    expect(clmmData.readBigUInt64LE(16)).toBe(680_000_000n); // min SOL out = baseOut

    // Orca leg sells SOL → aToB = true, amount = baseOut, min out = quoteIn + threshold
    expect(keys[orca.accountKeyIndexes[2]!]!.equals(orcaPool)).toBe(true);
    const orcaData = Buffer.from(orca.data);
    expect(orcaData.readBigUInt64LE(8)).toBe(680_000_000n);
    expect(orcaData.readBigUInt64LE(16)).toBe(100_010_000n);
    expect(orcaData.readUInt8(41)).toBe(1); // aToB true

    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true); // signed
  });

  it("buy on Orca / sell on CLMM: Orca leg buys SOL (aToB=false), CLMM leg inputs SOL (vault0)", () => {
    const payer = Keypair.generate();
    const reversed: Opportunity = {
      ...buyOnClmm,
      direction: { buyOn: "orca-whirlpool", sellOn: "raydium-clmm" },
    };
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, reversed);

    const keys = tx.message.staticAccountKeys;
    const orca = tx.message.compiledInstructions[0]!; // buy leg first
    const clmm = tx.message.compiledInstructions[1]!;

    // Orca leg buys SOL → aToB = false, amount = quoteIn, min out = baseOut
    const orcaData = Buffer.from(orca.data);
    expect(orcaData.readBigUInt64LE(8)).toBe(100_000_000n);
    expect(orcaData.readBigUInt64LE(16)).toBe(680_000_000n);
    expect(orcaData.readUInt8(41)).toBe(0); // aToB false

    // CLMM leg sells SOL → input is SOL (mint0) → input_vault = vault0,
    // amount = baseOut, min out = quoteIn + threshold
    expect(keys[clmm.accountKeyIndexes[5]!]!.equals(clmmVault0)).toBe(true);
    const clmmData = Buffer.from(clmm.data);
    expect(clmmData.readBigUInt64LE(8)).toBe(680_000_000n);
    expect(clmmData.readBigUInt64LE(16)).toBe(100_010_000n);
  });

  it("prepends a compute-budget instruction when a CU limit is given", () => {
    const payer = Keypair.generate();
    const tx = buildClmmOrcaArbTransaction({ ...ctx(payer), payer }, buyOnClmm, 240_000);
    expect(tx.message.compiledInstructions.length).toBe(3);
    const progIdx = tx.message.compiledInstructions[0]!.programIdIndex;
    expect(tx.message.staticAccountKeys[progIdx]!.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
  });

  it("shares one SOL ATA and one USDC ATA across both legs", () => {
    const surrogate = kp();
    const tx = buildClmmOrcaArbTransaction(ctx(surrogate), buyOnClmm);
    const keys = tx.message.staticAccountKeys;
    const clmm = tx.message.compiledInstructions[0]!;
    const orca = tx.message.compiledInstructions[1]!;
    // CLMM output_token_account (index 4) is the SOL ATA (buying SOL);
    // Orca tokenOwnerAccountA (index 3) is the SOL ATA (selling SOL).
    // They must be the same derived account.
    expect(
      keys[clmm.accountKeyIndexes[4]!]!.equals(keys[orca.accountKeyIndexes[3]!]!),
    ).toBe(true);
  });

  it("builds UNSIGNED with a PublicKey payer (shadow-mode surrogate)", () => {
    const surrogate = kp();
    const tx = buildClmmOrcaArbTransaction(ctx(surrogate), buyOnClmm);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(surrogate)).toBe(true);
  });
});
