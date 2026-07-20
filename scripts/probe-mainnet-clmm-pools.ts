/**
 * READ-ONLY mainnet probe for the deepest Raydium CLMM SOL/USDC pool.
 * Decodes the pool + its AmmConfig with OUR decoders (live half of the
 * dual-source offset verification) and reports pool orientation. Sends
 * nothing; needs no keypair; does not touch the running shadow.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "../src/decode/clmm.js";
import { sqrtPriceX64ToPrice } from "../src/math/whirlpool.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

async function main(): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.MAINNET_RPC_URL ??
    (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : undefined);
  if (!rpcUrl) throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
  const connection = new Connection(rpcUrl, "processed");

  const raydium = await Raydium.load({ connection, disableLoadToken: false });
  const usdc = raydium.token.tokenList.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("USDC not found in Raydium token list");
  console.log(`[probe] USDC mint per Raydium list: ${usdc.address}`);

  const clmmPools: Array<{ id: string; tvl: number }> = [];
  for (let page = 1; page <= 20; page++) {
    const pools = await raydium.api.fetchPoolByMints({
      mint1: SOL_MINT,
      mint2: usdc.address,
      page,
    });
    clmmPools.push(
      ...(pools.data ?? [])
        .filter((p) => p.programId === CLMM_PROGRAM)
        .map((p) => ({ id: p.id, tvl: p.tvl ?? 0 })),
    );
    if (!pools.hasNextPage) break;
  }
  clmmPools.sort((a, b) => b.tvl - a.tvl);
  if (clmmPools.length === 0) throw new Error("no Raydium CLMM SOL/USDC pool found");
  console.log(
    `[probe] top CLMM SOL/USDC pools by TVL:`,
    clmmPools.slice(0, 5).map((p) => `${p.id} ($${Math.round(p.tvl)})`),
  );

  const selected = clmmPools[0]!;
  const poolAcc = await connection.getAccountInfo(new PublicKey(selected.id));
  if (!poolAcc) throw new Error(`pool ${selected.id} account not found`);
  const state = decodeClmmPool(poolAcc.data);

  const cfgAcc = await connection.getAccountInfo(state.ammConfig);
  if (!cfgAcc) throw new Error(`amm_config ${state.ammConfig.toBase58()} not found`);
  const feeBps = decodeClmmAmmConfigFeeBps(cfgAcc.data);

  const solIsMint0 = state.tokenMint0.toBase58() === SOL_MINT;
  const inverted = !solIsMint0;
  const price = sqrtPriceX64ToPrice(
    state.sqrtPriceX64,
    solIsMint0 ? state.mintDecimals0 : state.mintDecimals1,
    solIsMint0 ? state.mintDecimals1 : state.mintDecimals0,
  );

  console.log(`\n=== LIVE CLMM DECODE (verification) ===`);
  console.log(`pool:        ${selected.id}  ($${Math.round(selected.tvl)} TVL)`);
  console.log(`amm_config:  ${state.ammConfig.toBase58()}`);
  console.log(`mint0:       ${state.tokenMint0.toBase58()} (dec ${state.mintDecimals0})`);
  console.log(`mint1:       ${state.tokenMint1.toBase58()} (dec ${state.mintDecimals1})`);
  console.log(`tickSpacing: ${state.tickSpacing}   tickCurrent: ${state.tickCurrentIndex}`);
  console.log(`feeBps:      ${feeBps}`);
  console.log(`sqrtPriceX64: ${state.sqrtPriceX64}`);
  console.log(`derived SOL/USDC price: ~${price.toFixed(2)}`);
  console.log(`\n>>> ORIENTATION: ${inverted ? "INVERTED (SOL is mint_1)" : "NORMAL (SOL is mint_0)"} <<<`);

  // Sanity gates — throw loudly if any offset is wrong.
  const mints = new Set([state.tokenMint0.toBase58(), state.tokenMint1.toBase58()]);
  if (!mints.has(SOL_MINT) || !mints.has(usdc.address)) {
    throw new Error("decoded mints are not SOL/USDC — offsets likely wrong");
  }
  if (!(price > 20 && price < 2000)) {
    throw new Error(`derived price ${price} outside sane SOL/USDC band — check offsets`);
  }
  if (!(feeBps > 0 && feeBps <= 100)) {
    throw new Error(`feeBps ${feeBps} outside sane CLMM tier band — check AmmConfig offset`);
  }
  console.log(`\n[probe] all sanity gates passed — offsets verified against live data.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
