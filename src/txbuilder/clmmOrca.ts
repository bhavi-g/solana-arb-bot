/**
 * Assembles ONE atomic transaction with BOTH arbitrage legs across two
 * DEXes: a Raydium CLMM swap_v2 leg and an Orca Whirlpool swap leg
 * (Phase-2 clmm-orca cross-DEX shadow venue). Buy base (SOL) cheap on one
 * venue, sell it on the other, in a single tx; the sell leg's minimum out
 * (quoteIn + minProfitThreshold) enforces profitability on-chain, and the
 * mandatory simulation catches an unprofitable trade before any send.
 *
 * The CLMM pool is SOL(mint0)/USDC(mint1) and the whirlpool is
 * SOL(A)/USDC(B), so both legs share the owner's SOL and USDC ATAs. The
 * legs disambiguate by DEX name — direction.buyOn/sellOn are
 * "raydium-clmm" vs "orca-whirlpool", which differ — so no pool-address
 * matching is needed (unlike the two-Orca builder).
 *
 * Structural analog of buildArbTransaction in ./index.ts (the CPMM-vs-Orca
 * builder): the CPMM leg is swapped for a CLMM leg; the direction mapping
 * is identical because SOL is token0 in both the CPMM and CLMM pools.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Opportunity, PairInfo } from "../types.js";
import type { ClmmPoolState } from "../decode/clmm.js";
import type { WhirlpoolState } from "../decode/orcaWhirlpool.js";
import { buildClmmSwapV2Ix } from "./raydiumClmm.js";
import { buildWhirlpoolSwapIx } from "./orcaWhirlpool.js";
import { associatedTokenAddress, TOKEN_PROGRAM_ID } from "./index.js";

export interface ClmmLeg {
  programId: PublicKey;
  poolAddress: PublicKey;
  state: ClmmPoolState;
  /** Current tick from the freshest snapshot (moves every cycle). */
  tickCurrentIndex: number;
}

export interface WhirlpoolLeg {
  programId: PublicKey;
  poolAddress: PublicKey;
  state: WhirlpoolState;
  /** Current tick from the freshest snapshot (moves every cycle). */
  tickCurrentIndex: number;
}

export interface ClmmOrcaBuildContext {
  payer: Keypair | PublicKey;
  recentBlockhash: string;
  pair: PairInfo;
  clmm: ClmmLeg;
  whirlpool: WhirlpoolLeg;
}

export function buildClmmOrcaArbTransaction(
  ctx: ClmmOrcaBuildContext,
  opp: Opportunity,
  computeUnitLimit?: number,
): VersionedTransaction {
  const owner = ctx.payer instanceof Keypair ? ctx.payer.publicKey : ctx.payer;
  const baseMint = new PublicKey(ctx.pair.baseMint);
  const quoteMint = new PublicKey(ctx.pair.quoteMint);
  const baseAta = associatedTokenAddress(owner, baseMint); // SOL
  const quoteAta = associatedTokenAddress(owner, quoteMint); // USDC

  const minQuoteOut = opp.quoteIn + opp.minProfitThreshold;
  const buyLegIsClmm = opp.direction.buyOn === "raydium-clmm";

  const clmmIx = buildClmmLeg(
    ctx,
    owner,
    baseAta,
    quoteAta,
    buyLegIsClmm
      ? { inputIsQuote: true, amount: opp.quoteIn, threshold: opp.baseOut }
      : { inputIsQuote: false, amount: opp.baseOut, threshold: minQuoteOut },
  );
  const whirlIx = buildWhirlpoolLeg(
    ctx,
    owner,
    baseAta,
    quoteAta,
    buyLegIsClmm
      ? { aToB: true, amount: opp.baseOut, threshold: minQuoteOut }
      : { aToB: false, amount: opp.quoteIn, threshold: opp.baseOut },
  );

  const legs = buyLegIsClmm ? [clmmIx, whirlIx] : [whirlIx, clmmIx];
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

function buildClmmLeg(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  leg: { inputIsQuote: boolean; amount: bigint; threshold: bigint },
): TransactionInstruction {
  const s = ctx.clmm.state;
  if (
    s.tokenMint0.toBase58() !== ctx.pair.baseMint ||
    s.tokenMint1.toBase58() !== ctx.pair.quoteMint
  ) {
    throw new Error(
      "CLMM pool orientation mismatch: expected base=mint0 / quote=mint1",
    );
  }
  // base (SOL) is token0, so quote-in means input is NOT token0.
  const inputIsToken0 = !leg.inputIsQuote;
  const inputVault = inputIsToken0 ? s.tokenVault0 : s.tokenVault1;
  const outputVault = inputIsToken0 ? s.tokenVault1 : s.tokenVault0;
  const inputMint = inputIsToken0 ? s.tokenMint0 : s.tokenMint1;
  const outputMint = inputIsToken0 ? s.tokenMint1 : s.tokenMint0;
  const inputTokenAccount = inputIsToken0 ? baseAta : quoteAta;
  const outputTokenAccount = inputIsToken0 ? quoteAta : baseAta;

  return buildClmmSwapV2Ix({
    programId: ctx.clmm.programId,
    payer: owner,
    ammConfig: s.ammConfig,
    poolState: ctx.clmm.poolAddress,
    inputTokenAccount,
    outputTokenAccount,
    inputVault,
    outputVault,
    observationState: s.observationKey,
    inputVaultMint: inputMint,
    outputVaultMint: outputMint,
    tickCurrentIndex: ctx.clmm.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: leg.amount,
    otherAmountThreshold: leg.threshold,
    inputIsToken0,
  });
}

function buildWhirlpoolLeg(
  ctx: ClmmOrcaBuildContext,
  owner: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  leg: { aToB: boolean; amount: bigint; threshold: bigint },
): TransactionInstruction {
  const s = ctx.whirlpool.state;
  return buildWhirlpoolSwapIx({
    programId: ctx.whirlpool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: ctx.whirlpool.poolAddress,
    tokenOwnerAccountA: baseAta,
    tokenVaultA: s.tokenVaultA,
    tokenOwnerAccountB: quoteAta,
    tokenVaultB: s.tokenVaultB,
    tickCurrentIndex: ctx.whirlpool.tickCurrentIndex,
    tickSpacing: s.tickSpacing,
    amount: leg.amount,
    otherAmountThreshold: leg.threshold,
    aToB: leg.aToB,
  });
}
