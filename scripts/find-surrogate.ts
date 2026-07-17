/**
 * READ-ONLY. Finds a mainnet surrogate owner for shadow-mode simulation:
 * a wallet whose USDC and WSOL ASSOCIATED token accounts both exist with
 * balances (the tx builder derives ATAs from the owner, so the surrogate's
 * holdings must live in ATAs). Prints candidates; the chosen one goes into
 * SURROGATE_OWNER for shadow runs. Nothing is sent, no keypair is needed.
 *
 * Discovery strategy: recent swappers of the deep Orca SOL/USDC whirlpool
 * (from data/pools.mainnet.json) necessarily touched both tokens; we take
 * owners from recent txs' postTokenBalances and keep the first whose WSOL
 * and USDC ATAs BOTH still exist with non-zero balances right now.
 * (getTokenLargestAccounts is unusable for USDC — the RPC refuses mints
 * with millions of accounts.)
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { associatedTokenAddress } from "../src/txbuilder/index.js";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "confirmed");

  const pools = JSON.parse(readFileSync("data/pools.mainnet.json", "utf8")) as {
    baseMint: string;
    quoteMint: string;
    orcaWhirlpool: string;
  };
  const usdcMint = new PublicKey(pools.quoteMint);
  const wsolMint = new PublicKey(pools.baseMint);
  const pool = new PublicKey(pools.orcaWhirlpool);

  const sigs = await connection.getSignaturesForAddress(pool, { limit: 25 });
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err !== null) continue;
    const tx = await connection.getParsedTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    const balances = tx?.meta?.postTokenBalances ?? [];
    for (const b of balances) {
      const owner = b.owner;
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      const ownerPk = new PublicKey(owner);
      // On-curve wallets only (PDAs like the pool authority are off-curve).
      if (!PublicKey.isOnCurve(ownerPk.toBytes())) continue;
      const [usdc, wsol] = await Promise.all([
        connection
          .getTokenAccountBalance(associatedTokenAddress(ownerPk, usdcMint))
          .catch(() => null),
        connection
          .getTokenAccountBalance(associatedTokenAddress(ownerPk, wsolMint))
          .catch(() => null),
      ]);
      if (!usdc || BigInt(usdc.value.amount) === 0n) continue;
      if (!wsol || BigInt(wsol.value.amount) === 0n) continue;
      console.log(
        `[surrogate] CANDIDATE ${owner} — USDC ${usdc.value.uiAmountString}, ` +
          `WSOL ${wsol.value.uiAmountString} (seen in ${s.signature})`,
      );
      return;
    }
  }
  console.log(
    "[surrogate] no recent swapper currently holds both ATAs — re-run later " +
      "or raise the signature limit",
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[surrogate] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
