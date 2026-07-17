/**
 * Assembles ONE atomic transaction with BOTH arbitrage legs on Orca
 * Whirlpools (Phase-2 two-Orca shadow venue). Buy base (SOL) cheap on one
 * whirlpool, sell it on the other, in a single tx; the sell leg's minimum
 * out (quoteIn + minProfitThreshold) enforces profitability on-chain, and
 * the mandatory simulation catches an unprofitable trade before any send.
 *
 * Both whirlpools are SOL(A)/USDC(B), so both legs share the owner's SOL
 * and USDC ATAs; each leg uses its own pool's vaults, ticks, and program.
 * The buy/sell pools are identified by ArbDirection's pool addresses
 * (buyOn/sellOn are both "orca-whirlpool" and cannot disambiguate).
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
import type { WhirlpoolState } from "../decode/orcaWhirlpool.js";
import { buildWhirlpoolSwapIx } from "./orcaWhirlpool.js";
import { associatedTokenAddress, TOKEN_PROGRAM_ID } from "./index.js";

export interface WhirlpoolLeg {
  programId: PublicKey;
  poolAddress: PublicKey;
  state: WhirlpoolState;
  /** Current tick from the freshest snapshot (moves every cycle). */
  tickCurrentIndex: number;
}

export interface TwoWhirlpoolBuildContext {
  payer: Keypair | PublicKey;
  recentBlockhash: string;
  pair: PairInfo;
  whirlpoolA: WhirlpoolLeg;
  whirlpoolB: WhirlpoolLeg;
}

export function buildTwoWhirlpoolArbTransaction(
  ctx: TwoWhirlpoolBuildContext,
  opp: Opportunity,
  computeUnitLimit?: number,
): VersionedTransaction {
  const owner = ctx.payer instanceof Keypair ? ctx.payer.publicKey : ctx.payer;
  const baseMint = new PublicKey(ctx.pair.baseMint);
  const quoteMint = new PublicKey(ctx.pair.quoteMint);
  const baseAta = associatedTokenAddress(owner, baseMint); // SOL / token A
  const quoteAta = associatedTokenAddress(owner, quoteMint); // USDC / token B

  const buyPool = matchPool(ctx, opp.direction.buyPoolAddress, "buy");
  const sellPool = buyPool === ctx.whirlpoolA ? ctx.whirlpoolB : ctx.whirlpoolA;

  const minQuoteOut = opp.quoteIn + opp.minProfitThreshold;

  // Buy leg: spend USDC to get SOL — token B -> token A, so aToB = false.
  const buyIx = buildWhirlpoolSwapIx({
    programId: buyPool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: buyPool.poolAddress,
    tokenOwnerAccountA: baseAta,
    tokenVaultA: buyPool.state.tokenVaultA,
    tokenOwnerAccountB: quoteAta,
    tokenVaultB: buyPool.state.tokenVaultB,
    tickCurrentIndex: buyPool.tickCurrentIndex,
    tickSpacing: buyPool.state.tickSpacing,
    amount: opp.quoteIn,
    otherAmountThreshold: opp.baseOut,
    aToB: false,
  });

  // Sell leg: spend SOL to get USDC — token A -> token B, so aToB = true.
  const sellIx = buildWhirlpoolSwapIx({
    programId: sellPool.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenAuthority: owner,
    whirlpool: sellPool.poolAddress,
    tokenOwnerAccountA: baseAta,
    tokenVaultA: sellPool.state.tokenVaultA,
    tokenOwnerAccountB: quoteAta,
    tokenVaultB: sellPool.state.tokenVaultB,
    tickCurrentIndex: sellPool.tickCurrentIndex,
    tickSpacing: sellPool.state.tickSpacing,
    amount: opp.baseOut,
    otherAmountThreshold: minQuoteOut,
    aToB: true,
  });

  const instructions: TransactionInstruction[] =
    computeUnitLimit !== undefined
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }), buyIx, sellIx]
      : [buyIx, sellIx];

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: ctx.recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (ctx.payer instanceof Keypair) tx.sign([ctx.payer]);
  return tx;
}

function matchPool(
  ctx: TwoWhirlpoolBuildContext,
  address: string | undefined,
  which: "buy" | "sell",
): WhirlpoolLeg {
  if (address === ctx.whirlpoolA.poolAddress.toBase58()) return ctx.whirlpoolA;
  if (address === ctx.whirlpoolB.poolAddress.toBase58()) return ctx.whirlpoolB;
  throw new Error(
    `${which} pool ${address} matches neither configured whirlpool ` +
      `(${ctx.whirlpoolA.poolAddress.toBase58()} / ${ctx.whirlpoolB.poolAddress.toBase58()})`,
  );
}
