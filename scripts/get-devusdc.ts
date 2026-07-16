/**
 * One-time devnet setup utility — NOT part of the bot. Wraps a small amount
 * of devnet SOL into WSOL, then swaps some of that WSOL for devUSDC through
 * the Orca Tour-de-Whirlpool SOL/devUSDC pool (there is no standalone
 * devUSDC faucet; Orca's docs say to obtain it by swapping through this
 * pool). Uses the wallet at KEYPAIR_PATH, same as the bot.
 *
 * Run: npx tsx scripts/get-devusdc.ts
 */
import "dotenv/config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, Wallet as AnchorWallet } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import {
  IGNORE_CACHE,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  WhirlpoolContext,
  buildDefaultAccountFetcher,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
} from "@orca-so/whirlpools-sdk";
import { loadOrCreateKeypair } from "../src/wallet.js";

// SOL/devUSDC Orca Tour-de-Whirlpool pool (verified live in
// docs/sessions/2026-07-16.md via scripts/probe-devnet-pools.ts).
const ORCA_POOL = new PublicKey("3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
const DEVUSDC_MINT = new PublicKey("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k");

const WRAP_LAMPORTS = 50_000_000; // 0.05 SOL -> WSOL
const SWAP_LAMPORTS = new BN(30_000_000); // 0.03 WSOL -> devUSDC
const SLIPPAGE = Percentage.fromFraction(100, 10_000); // 1%

function connectDevnet(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY;
  const rpcUrl = heliusKey
    ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
    : "https://api.devnet.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

async function wrapSol(
  connection: Connection,
  wallet: ReturnType<typeof loadOrCreateKeypair>,
  wsolAta: PublicKey,
): Promise<void> {
  console.log(`Wrapping ${WRAP_LAMPORTS / 1e9} SOL into WSOL...`);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      wsolAta,
      wallet.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAta,
      lamports: WRAP_LAMPORTS,
    }),
    createSyncNativeInstruction(wsolAta),
  );

  const sim = await connection.simulateTransaction(tx, [wallet]);
  if (sim.value.err) {
    throw new Error(`wrap simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("Wrapped. tx:", sig);
}

async function swapWsolForDevUsdc(
  connection: Connection,
  wallet: ReturnType<typeof loadOrCreateKeypair>,
): Promise<void> {
  console.log(`Swapping ${SWAP_LAMPORTS.toNumber() / 1e9} WSOL for devUSDC...`);
  const ctx = WhirlpoolContext.from(
    connection,
    new AnchorWallet(wallet),
    buildDefaultAccountFetcher(connection),
    undefined,
    undefined,
    ORCA_WHIRLPOOL_PROGRAM_ID,
  );
  const client = buildWhirlpoolClient(ctx);
  const pool = await client.getPool(ORCA_POOL, IGNORE_CACHE);

  const quote = await swapQuoteByInputToken(
    pool,
    NATIVE_MINT,
    SWAP_LAMPORTS,
    SLIPPAGE,
    ctx.program.programId,
    ctx.fetcher,
    IGNORE_CACHE,
  );

  const txBuilder = await pool.swap(quote);
  const { transaction, signers } = await txBuilder.build({
    maxSupportedTransactionVersion: "legacy",
    blockhashCommitment: "confirmed",
  });

  const sim = await connection.simulateTransaction(transaction as Transaction, [
    wallet,
    ...signers,
  ]);
  if (sim.value.err) {
    throw new Error(
      `swap simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`,
    );
  }

  const sig = await txBuilder.buildAndExecute();
  await connection.confirmTransaction(sig, "confirmed");
  console.log("Swapped. tx:", sig);
}

async function main() {
  const keypairPath = process.env.KEYPAIR_PATH ?? "keypairs/devnet.json";
  const wallet = loadOrCreateKeypair(keypairPath);
  console.log("Wallet:", wallet.publicKey.toBase58());

  const connection = connectDevnet();
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const devUsdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, wallet.publicKey);

  await wrapSol(connection, wallet, wsolAta);
  await swapWsolForDevUsdc(connection, wallet);

  const devUsdcAccount = await getAccount(connection, devUsdcAta);
  console.log(`\ndevUSDC balance: ${Number(devUsdcAccount.amount) / 1e6} devUSDC`);
}

main().catch((e) => {
  console.error("get-devusdc failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
