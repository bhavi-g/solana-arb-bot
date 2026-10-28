/**
 * Assembles ONE atomic transaction containing both arbitrage legs.
 *
 * Profitability is enforced ON-CHAIN: the sell leg's minimum-out is set
 * to quoteIn + minProfitThreshold, so if state moved and the numbers no
 * longer clear the threshold, the whole transaction reverts (and the
 * mandatory simulation in the executor catches it before we even pay a
 * fee). The buy leg's minimum-out is the detection estimate, guaranteeing
 * the sell leg's input amount exists. This guard arithmetic is computed
 * by the arb-math Rust crate, not inline TS (ADR-0011).
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { PairInfo, Opportunity } from "../types.js";
import type { RaydiumCpmmPoolState } from "../decode/raydiumCpmm.js";
import type { WhirlpoolState } from "../decode/orcaWhirlpool.js";
import { minQuoteOutViaRust } from "../rustmath.js";
import { buildCpmmSwapBaseInputIx } from "./raydiumCpmm.js";
import { buildWhirlpoolSwapIx } from "./orcaWhirlpool.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export interface ArbBuildContext {
  /**
   * Keypair → tx is signed (Phase-1 live path). PublicKey → tx is built
   * UNSIGNED for shadow-mode simulation as a surrogate owner
   * (sigVerify:false); an unsigned tx is also unsubmittable — an extra
   * ADR-0008 barrier.
   */
  payer: Keypair | PublicKey;
  recentBlockhash: string;
  pair: PairInfo;
  raydium: {
    programId: PublicKey;
    poolAddress: PublicKey;
    state: RaydiumCpmmPoolState;
  };
  whirlpool: {
    programId: PublicKey;
    poolAddress: PublicKey;
    state: WhirlpoolState;
    /** Current tick from the freshest snapshot (moves every cycle). */
    tickCurrentIndex: number;
  };
}

export function buildArbTransaction(
  ctx: ArbBuildContext,
  opp: Opportunity,
  computeUnitLimit?: number,
): VersionedTransaction {
  const baseMint = new PublicKey(ctx.pair.baseMint);
  const quoteMint = new PublicKey(ctx.pair.quoteMint);
  const owner = ctx.payer instanceof Keypair ? ctx.payer.publicKey : ctx.payer;

  const minQuoteOut = minQuoteOutViaRust(opp.quoteIn, opp.minProfitThreshold);

  const buyLegIsCpmm = opp.direction.buyOn === "raydium-cpmm";
  const cpmmIx = buildCpmmLeg(
    ctx,
    owner,
    baseMint,
    buyLegIsCpmm
      ? { inputIsQuote: true, amountIn: opp.quoteIn, minOut: opp.baseOut }
      : { inputIsQuote: false, amountIn: opp.baseOut, minOut: minQuoteOut },
  );
  const whirlIx = buildWhirlpoolLeg(
    ctx,
    owner,
    baseMint,
    quoteMint,
    buyLegIsCpmm
      ? { aToB: true, amount: opp.baseOut, threshold: minQuoteOut }
      : { aToB: false, amount: opp.quoteIn, threshold: opp.baseOut },
  );

  const legs = buyLegIsCpmm ? [cpmmIx, whirlIx] : [whirlIx, cpmmIx];
  const instructions: TransactionInstruction[] =
    computeUnitLimit !== undefined
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }), ...legs]
      : legs;

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: ctx.recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (ctx.payer instanceof Keypair) tx.sign([ctx.payer]);
  return tx;
}

function buildCpmmLeg(
  ctx: ArbBuildContext,
  owner: PublicKey,
  baseMint: PublicKey,
  leg: { inputIsQuote: boolean; amountIn: bigint; minOut: bigint },
): TransactionInstruction {
  const s = ctx.raydium.state;
  if (!s.token0Mint.equals(baseMint) && !s.token1Mint.equals(baseMint)) {
    throw new Error("Raydium pool does not contain the configured base mint");
  }
  const baseIsToken0 = s.token0Mint.equals(baseMint);
  const inputIsToken0 = leg.inputIsQuote ? !baseIsToken0 : baseIsToken0;

  const inputMint = inputIsToken0 ? s.token0Mint : s.token1Mint;
  const outputMint = inputIsToken0 ? s.token1Mint : s.token0Mint;
  const inputVault = inputIsToken0 ? s.token0Vault : s.token1Vault;
  const outputVault = inputIsToken0 ? s.token1Vault : s.token0Vault;
  const inputProgram = inputIsToken0 ? s.token0Program : s.token1Program;
  const outputProgram = inputIsToken0 ? s.token1Program : s.token0Program;

  return buildCpmmSwapBaseInputIx({
    programId: ctx.raydium.programId,
    payer: owner,
    ammConfig: s.ammConfig,
    poolState: ctx.raydium.poolAddress,
    inputTokenAccount: associatedTokenAddress(owner, inputMint, inputProgram),
    outputTokenAccount: associatedTokenAddress(owner, outputMint, outputProgram),
    inputVault,
    outputVault,
    inputTokenProgram: inputProgram,
    outputTokenProgram: outputProgram,
    inputMint,
    outputMint,
    observationState: s.observationKey,
    amountIn: leg.amountIn,
    minimumAmountOut: leg.minOut,
  });
}

function buildWhirlpoolLeg(
  ctx: ArbBuildContext,
  owner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  leg: { aToB: boolean; amount: bigint; threshold: bigint },
): TransactionInstruction {
  const s = ctx.whirlpool.state;
  return buildWhirlpoolSwapIx({
    programId: ctx.whirlpool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: ctx.whirlpool.poolAddress,
    tokenOwnerAccountA: associatedTokenAddress(owner, baseMint),
    tokenVaultA: s.tokenVaultA,
    tokenOwnerAccountB: associatedTokenAddress(owner, quoteMint),
    tokenVaultB: s.tokenVaultB,
    tickCurrentIndex: ctx.whirlpool.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: leg.amount,
    otherAmountThreshold: leg.threshold,
    aToB: leg.aToB,
  });
}
