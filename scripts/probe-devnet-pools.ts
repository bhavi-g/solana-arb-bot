/**
 * Devnet research probe (read-only, ~4 RPC requests): verifies the Orca
 * Tour-de-Whirlpool SOL/devUSDC pool decodes with our layout, and lists
 * Raydium CPMM devnet pools containing WSOL.
 *
 * Run: npx tsx scripts/probe-devnet-pools.ts
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";
import { decodeRaydiumCpmmPool } from "../src/decode/raydiumCpmm.js";
import { sqrtPriceX64ToPrice } from "../src/math/whirlpool.js";

const WSOL = "So11111111111111111111111111111111111111112";
const ORCA_POOL = new PublicKey("3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
const RAYDIUM_DEVNET_PROGRAM = new PublicKey(
  "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
);
const POOL_STATE_SIZE = 637;

const key = process.env.HELIUS_API_KEY;
const url = key
  ? `https://devnet.helius-rpc.com/?api-key=${key}`
  : "https://api.devnet.solana.com";
const conn = new Connection(url, "processed");

async function main() {
  const orcaAcc = await conn.getAccountInfo(ORCA_POOL);
  if (!orcaAcc) {
    console.log("ORCA: pool account NOT FOUND on devnet");
  } else {
    const w = decodeWhirlpool(orcaAcc.data);
    console.log("ORCA: found, owner =", orcaAcc.owner.toBase58());
    console.log("  mintA:", w.tokenMintA.toBase58());
    console.log("  mintB:", w.tokenMintB.toBase58());
    console.log("  tickSpacing:", w.tickSpacing, "feeBps:", w.feeBps);
    console.log("  liquidity:", w.liquidity.toString());
    console.log("  sqrtPriceX64:", w.sqrtPriceX64.toString());
    console.log("  humanPrice(B/A, dec 9/6):", sqrtPriceX64ToPrice(w.sqrtPriceX64, 9, 6));
  }

  for (const offset of [168, 200]) {
    const accounts = await conn.getProgramAccounts(RAYDIUM_DEVNET_PROGRAM, {
      filters: [
        { dataSize: POOL_STATE_SIZE },
        { memcmp: { offset, bytes: WSOL } },
      ],
    });
    console.log(`RAYDIUM: ${accounts.length} pools with WSOL at offset ${offset}`);
    for (const { pubkey, account } of accounts.slice(0, 5)) {
      const p = decodeRaydiumCpmmPool(account.data);
      console.log(
        `  ${pubkey.toBase58()} mint0=${p.token0Mint.toBase58()} mint1=${p.token1Mint.toBase58()} dec ${p.mint0Decimals}/${p.mint1Decimals}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
