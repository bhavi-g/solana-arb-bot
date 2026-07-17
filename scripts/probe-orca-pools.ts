/**
 * READ-ONLY. Lists mainnet Orca SOL/USDC whirlpools by TVL, with their
 * tick spacing (fee tier), decoded on-chain state, and their live USDC
 * vault (token B) balance — so we can confirm two independent pools each
 * clear the 100k-USDC depth gate before choosing them as the Phase-2
 * two-Orca shadow venues. Sends nothing.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_QUOTE_RESERVE = 100_000_000_000n; // 100k USDC (6dp)

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const pools = JSON.parse(readFileSync("data/pools.mainnet.json", "utf8")) as {
    quoteMint: string;
  };
  const usdc = pools.quoteMint;

  const resp = await fetch("https://api.mainnet.orca.so/v1/whirlpool/list");
  if (!resp.ok) throw new Error(`orca list HTTP ${resp.status}`);
  const list = (await resp.json()) as {
    whirlpools: Array<{
      address: string;
      tokenA: { mint: string };
      tokenB: { mint: string };
      tvl?: number;
    }>;
  };
  const candidates = list.whirlpools
    .filter((w) => w.tokenA.mint === SOL_MINT && w.tokenB.mint === usdc)
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
    .slice(0, 6);

  console.log(`[orca] top ${candidates.length} SOL/USDC whirlpools by TVL:`);
  const cleared: Array<{ address: string; tickSpacing: number; usdc: bigint }> = [];
  for (const c of candidates) {
    const acc = await connection.getAccountInfo(new PublicKey(c.address));
    if (!acc) {
      console.log(`  ${c.address}  (account missing on-chain — skip)`);
      continue;
    }
    const w = decodeWhirlpool(acc.data);
    const vaultBal = await connection.getTokenAccountBalance(w.tokenVaultB);
    const usdcReserve = BigInt(vaultBal.value.amount);
    const ok = usdcReserve >= MIN_QUOTE_RESERVE;
    console.log(
      `  ${c.address}  tickSpacing=${w.tickSpacing} feeBps=${w.feeBps} ` +
        `tvl=$${Math.round(c.tvl ?? 0)} USDCvault=${vaultBal.value.uiAmountString} ` +
        `${ok ? "✅ clears 100k" : "❌ below 100k"}`,
    );
    if (ok) cleared.push({ address: c.address, tickSpacing: w.tickSpacing, usdc: usdcReserve });
  }

  console.log(
    `\n[orca] ${cleared.length} pool(s) clear the 100k-USDC gate. ` +
      (cleared.length >= 2
        ? `Two-Orca venues: ${cleared[0]!.address} (spacing ${cleared[0]!.tickSpacing}) ` +
          `vs ${cleared[1]!.address} (spacing ${cleared[1]!.tickSpacing}).`
        : "NOT ENOUGH — need two independent pools; STOP AND ASK OWNER."),
  );
}

main().catch((e) => {
  console.error(`[orca] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
