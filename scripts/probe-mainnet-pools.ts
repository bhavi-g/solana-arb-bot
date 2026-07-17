/**
 * READ-ONLY mainnet probe. Discovers a Raydium CPMM SOL/USDC pool and the
 * deepest Orca Whirlpool SOL/USDC pool, verifies both by decoding the
 * actual on-chain accounts with OUR decoders, and writes
 * data/pools.mainnet.json. Sends nothing; needs no keypair.
 *
 * Addresses are discovered live (project rule: never trust remembered
 * addresses). The SOL and USDC mints are cross-checked against what the
 * pools themselves store on-chain.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { writeFileSync } from "node:fs";
import { decodeRaydiumCpmmPool } from "../src/decode/raydiumCpmm.js";
import { decodeWhirlpool } from "../src/decode/orcaWhirlpool.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
// Owner gate (plan Global Constraints): below this quote depth, STOP AND ASK.
const MIN_CPMM_QUOTE_RESERVE = 100_000_000_000n; // 100k USDC (6dp)

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  // --- USDC mint via Raydium API token list (verified on-chain below) ---
  const raydium = await Raydium.load({ connection, disableLoadToken: false });
  const usdc = raydium.token.tokenList.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("USDC not found in Raydium token list");
  console.log(`[probe] USDC mint per Raydium list: ${usdc.address}`);

  // --- Raydium CPMM SOL/USDC pool: pick deepest CPMM-program pool.
  // Paginate exhaustively: results are TVL-sorted across ALL program types,
  // so the deepest CPMM pool may sit on a later page.
  const cpmmPools: Array<{ programId: string; id: string; tvl: number }> = [];
  for (let page = 1; page <= 20; page++) {
    const pools = await raydium.api.fetchPoolByMints({
      mint1: SOL_MINT,
      mint2: usdc.address,
      page,
    });
    cpmmPools.push(
      ...(pools.data ?? []).filter((p) => p.programId === CPMM_PROGRAM),
    );
    if (!pools.hasNextPage) break;
  }
  if (cpmmPools.length === 0) {
    throw new Error("no SOL/USDC pool on the CPMM program found via API");
  }
  cpmmPools.sort((a, b) => b.tvl - a.tvl);
  const rayApi = cpmmPools[0]!;
  console.log(`[probe] Raydium CPMM candidate ${rayApi.id} (tvl $${rayApi.tvl})`);

  // --- Orca whirlpool SOL/USDC: deepest from Orca's public list ---
  const orcaResp = await fetch("https://api.mainnet.orca.so/v1/whirlpool/list");
  if (!orcaResp.ok) throw new Error(`orca list HTTP ${orcaResp.status}`);
  const orcaList = (await orcaResp.json()) as {
    whirlpools: Array<{
      address: string;
      tokenA: { mint: string };
      tokenB: { mint: string };
      tvl?: number;
    }>;
  };
  const orcaCandidates = orcaList.whirlpools
    .filter(
      (w) => w.tokenA.mint === SOL_MINT && w.tokenB.mint === usdc.address,
    )
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  if (orcaCandidates.length === 0) throw new Error("no SOL/USDC whirlpool found");
  const orcaApi = orcaCandidates[0]!;
  console.log(`[probe] Orca whirlpool candidate ${orcaApi.address} (tvl $${orcaApi.tvl})`);

  // --- VERIFY both on-chain with our own decoders ---
  const [rayAcc, orcaAcc] = await connection.getMultipleAccountsInfo([
    new PublicKey(rayApi.id),
    new PublicKey(orcaApi.address),
  ]);
  if (!rayAcc || !orcaAcc) throw new Error("candidate account(s) missing on-chain");
  const ray = decodeRaydiumCpmmPool(rayAcc.data);
  const orca = decodeWhirlpool(orcaAcc.data);

  const rayMints = [ray.token0Mint.toBase58(), ray.token1Mint.toBase58()];
  if (!rayMints.includes(SOL_MINT) || !rayMints.includes(usdc.address)) {
    throw new Error(`CPMM pool mints ${rayMints.join(",")} != SOL/USDC — refusing`);
  }
  if (
    orca.tokenMintA.toBase58() !== SOL_MINT ||
    orca.tokenMintB.toBase58() !== usdc.address
  ) {
    throw new Error("whirlpool mints are not SOL(A)/USDC(B) — refusing");
  }

  // --- Depth check: read the CPMM USDC vault balance ---
  const usdcVault =
    ray.token0Mint.toBase58() === usdc.address ? ray.token0Vault : ray.token1Vault;
  const vaultBal = await connection.getTokenAccountBalance(usdcVault);
  if (vaultBal.value.decimals !== 6) {
    throw new Error(`USDC vault decimals ${vaultBal.value.decimals} != 6 — refusing`);
  }
  const quoteReserve = BigInt(vaultBal.value.amount);
  console.log(`[probe] CPMM USDC reserve: ${vaultBal.value.uiAmountString}`);
  const depthOk = quoteReserve >= MIN_CPMM_QUOTE_RESERVE;
  if (!depthOk) {
    console.log(
      "[probe] *** DEPTH GATE FAILED: < 100k USDC — STOP AND ASK THE OWNER " +
        "before any shadow run (owner Decision 6). ***",
    );
  }

  const out = {
    probedAt: new Date().toISOString(),
    cluster: "mainnet-beta",
    baseMint: SOL_MINT,
    quoteMint: usdc.address,
    baseDecimals: 9,
    quoteDecimals: 6,
    raydiumCpmmPool: rayApi.id,
    orcaWhirlpool: orcaApi.address,
    observed: {
      raydiumTvlUsd: rayApi.tvl,
      orcaTvlUsd: orcaApi.tvl ?? null,
      cpmmUsdcReserve: quoteReserve.toString(),
      whirlpoolLiquidity: orca.liquidity.toString(),
      whirlpoolTickCurrentIndex: orca.tickCurrentIndex,
      depthGatePassed: depthOk,
    },
  };
  writeFileSync("data/pools.mainnet.json", JSON.stringify(out, null, 2) + "\n");
  console.log("[probe] wrote data/pools.mainnet.json");
}

main().catch((e) => {
  console.error(`[probe] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
