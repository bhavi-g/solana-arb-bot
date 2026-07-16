/**
 * Devnet pool-seeding utility — NOT part of the bot. Creates our OWN
 * Raydium CPMM pool and Orca Whirlpool (splash) for WSOL/devUSDC, seeded at
 * deliberately different prices so the bot can detect a real arb gap and
 * land an actual send (the final Phase-1 exit criterion).
 *
 * Spends REAL devnet funds. The spend decisions (how much to deposit, price
 * gap, balance guards) are the pure, unit-tested buildSeedPlan (src/seed/
 * plan.ts, tests/seedPlan.test.ts). This file is the on-chain I/O only.
 *
 * Idempotent: created pool addresses are persisted to
 * data/seeded-pools.devnet.json; a re-run after a failure skips whatever is
 * already recorded rather than creating duplicates.
 *
 * Run: npx tsx scripts/seed-devnet-pools.ts
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import {
  CpmmConfigInfoLayout,
  DEVNET_PROGRAM_ID,
  Raydium,
  TxVersion,
  getCpmmPdaAmmConfigId,
  type ApiCpmmConfigInfo,
} from "@raydium-io/raydium-sdk-v2";
import { loadOrCreateKeypair } from "../src/wallet.js";
import { buildSeedPlan, type SeedPlan } from "../src/seed/plan.js";

// ---- Pair + config (WSOL/devUSDC on devnet) --------------------------------
const DEVUSDC_MINT = new PublicKey(
  "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k",
);
const BASE_DECIMALS = 9; // WSOL
const QUOTE_DECIMALS = 6; // devUSDC
// Existing deep devnet WSOL/devUSDC whirlpool (price ~22, 373 WSOL / 6234
// devUSDC). Adopted as the second venue since we cannot create our own.
const ORCA_EXISTING_POOL = new PublicKey(
  "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt",
);

// ---- Seed parameters (thin pools + large gap; see session log 2d) ----------
// mid price = 150 devUSDC/SOL -> raw 0.15 quote-raw per base-raw.
const MID_PRICE = { num: 150_000_000n, den: 1_000_000_000n };
const GAP_BPS = 800; // raydium 8% below mid (only affects our Raydium seed)
const BASE_DEPOSIT_RAW = 6_000_000n; // ~0.006 WSOL into EACH pool's base side
const MIN_QUOTE_DEPOSIT_RAW = 500_000n; // 0.5 devUSDC non-dust floor
const WSOL_BUFFER_RAW = 5_000_000n; // extra WSOL to wrap for fees/rent slack
// AmmConfig index for OUR new CPMM pool. Index 0/1 already have WSOL/devUSDC
// pools on devnet (EEKfr2…, 9ex5F2… from earlier sessions); index 2 is free,
// so createPool derives a fresh pool PDA we control the price of.
const CPMM_CONFIG_INDEX = 2;

const STATE_PATH = "data/seeded-pools.devnet.json";

interface SeededState {
  cluster: "devnet";
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  raydiumPoolAddress?: string;
  orcaPoolAddress?: string;
  notes?: string;
}

function loadState(): SeededState {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SeededState;
  }
  return {
    cluster: "devnet",
    baseMint: NATIVE_MINT.toBase58(),
    quoteMint: DEVUSDC_MINT.toBase58(),
    baseDecimals: BASE_DECIMALS,
    quoteDecimals: QUOTE_DECIMALS,
  };
}

function saveState(s: SeededState): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

function connectDevnet(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY;
  const rpcUrl = heliusKey
    ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
    : "https://api.devnet.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

async function tokenAmount(
  connection: Connection,
  ata: PublicKey,
): Promise<bigint> {
  try {
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

/** Ensure the WSOL ATA holds at least `need` lamports; wrap SOL if short. */
async function ensureWsol(
  connection: Connection,
  wallet: Keypair,
  wsolAta: PublicKey,
  need: bigint,
): Promise<void> {
  const have = await tokenAmount(connection, wsolAta);
  if (have >= need) {
    console.log(`WSOL sufficient: have ${have}, need ${need}`);
    return;
  }
  const toWrap = need - have;
  console.log(`Wrapping ${Number(toWrap) / 1e9} SOL into WSOL...`);
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
      lamports: Number(toWrap),
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

/** Reconstruct the devnet CPMM feeConfig from its on-chain account. */
async function devnetCpmmFeeConfig(
  connection: Connection,
): Promise<ApiCpmmConfigInfo> {
  const programId = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM as PublicKey;
  const configId = getCpmmPdaAmmConfigId(programId, CPMM_CONFIG_INDEX).publicKey;
  const acc = await connection.getAccountInfo(configId);
  if (!acc) throw new Error(`devnet CPMM AmmConfig ${configId} not found`);
  const c = CpmmConfigInfoLayout.decode(acc.data);
  return {
    id: configId.toBase58(),
    index: c.index,
    protocolFeeRate: c.protocolFeeRate.toNumber(),
    tradeFeeRate: c.tradeFeeRate.toNumber(),
    fundFeeRate: c.fundFeeRate.toNumber(),
    createPoolFee: c.createPoolFee.toString(),
    creatorFeeRate: 0,
  };
}

async function seedRaydium(
  connection: Connection,
  wallet: Keypair,
  plan: SeedPlan,
  state: SeededState,
): Promise<void> {
  if (state.raydiumPoolAddress) {
    console.log(`Raydium pool already seeded: ${state.raydiumPoolAddress}`);
    return;
  }
  console.log("Creating Raydium CPMM pool...");
  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
  });
  const feeConfig = await devnetCpmmFeeConfig(connection);

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM as PublicKey,
    poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC as PublicKey,
    mintA: {
      address: NATIVE_MINT.toBase58(),
      decimals: BASE_DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintB: {
      address: DEVUSDC_MINT.toBase58(),
      decimals: QUOTE_DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintAAmount: new BN(plan.raydium.baseRaw.toString()),
    mintBAmount: new BN(plan.raydium.quoteRaw.toString()),
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  const poolId = extInfo.address.poolId.toString();
  console.log(`Raydium CPMM pool created: ${poolId} (tx ${txId})`);
  state.raydiumPoolAddress = poolId;
  saveState(state);
}

/**
 * Adopt an existing deep Orca WSOL/devUSDC whirlpool as the second venue.
 *
 * We cannot create our OWN Orca pool for this pair on devnet: every tick
 * spacing that has a fee tier on config Fcrwe… already has a WSOL/devUSDC
 * whirlpool, and the one free spacing (96) has no fee tier (only Orca's
 * config authority can add one). So we use the existing deep pool
 * ORCA_EXISTING_POOL as-is. Our fresh Raydium pool is priced differently
 * from it, which is what creates the executable arb gap (see session log).
 */
async function seedOrca(
  connection: Connection,
  _wallet: Keypair,
  _plan: SeedPlan,
  state: SeededState,
): Promise<void> {
  if (state.orcaPoolAddress) {
    console.log(`Orca venue already set: ${state.orcaPoolAddress}`);
    return;
  }
  const acc = await connection.getAccountInfo(ORCA_EXISTING_POOL);
  if (!acc) {
    throw new Error(`Orca venue ${ORCA_EXISTING_POOL} not found on devnet`);
  }
  console.log(
    `Adopting existing deep Orca whirlpool as second venue: ${ORCA_EXISTING_POOL.toBase58()}`,
  );
  state.orcaPoolAddress = ORCA_EXISTING_POOL.toBase58();
  state.notes =
    "Orca side is the existing deep devnet pool 3KBZiL2g (cannot create our " +
    "own WSOL/devUSDC whirlpool: all fee-tier tick spacings already have " +
    "pools). Arb gap comes from our Raydium pool being priced differently.";
  saveState(state);
}

async function main(): Promise<void> {
  const wallet = loadOrCreateKeypair(
    process.env.KEYPAIR_PATH ?? "keypairs/devnet.json",
  );
  console.log("Wallet:", wallet.publicKey.toBase58());
  const connection = connectDevnet();

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const devUsdcAta = getAssociatedTokenAddressSync(
    DEVUSDC_MINT,
    wallet.publicKey,
  );

  const availableBase = await tokenAmount(connection, wsolAta);
  const availableQuote = await tokenAmount(connection, devUsdcAta);
  console.log(
    `Balances: WSOL ${availableBase} raw, devUSDC ${availableQuote} raw`,
  );

  // Wrap enough WSOL to cover both pools' base deposits + buffer up front.
  const baseNeed = BASE_DEPOSIT_RAW * 2n + WSOL_BUFFER_RAW;
  await ensureWsol(connection, wallet, wsolAta, baseNeed);
  const availableBaseAfter = await tokenAmount(connection, wsolAta);

  const state = loadState();
  const plan = buildSeedPlan({
    cluster: "devnet",
    baseDepositRaw: BASE_DEPOSIT_RAW,
    midPrice: MID_PRICE,
    gapBps: GAP_BPS,
    minQuoteDepositRaw: MIN_QUOTE_DEPOSIT_RAW,
    available: { baseRaw: availableBaseAfter, quoteRaw: availableQuote },
    alreadySeeded: {
      raydium: !!state.raydiumPoolAddress,
      orca: !!state.orcaPoolAddress,
    },
  });
  console.log("Seed plan:", {
    raydium: {
      baseRaw: plan.raydium.baseRaw.toString(),
      quoteRaw: plan.raydium.quoteRaw.toString(),
    },
    orca: {
      baseRaw: plan.orca.baseRaw.toString(),
      quoteRaw: plan.orca.quoteRaw.toString(),
    },
    expectedGapBps: plan.expectedGapBps,
  });

  await seedRaydium(connection, wallet, plan, state);
  await seedOrca(connection, wallet, plan, state);

  console.log("\nDone. Seeded pools:");
  console.log("  RAYDIUM_POOL_ADDRESS =", state.raydiumPoolAddress);
  console.log("  ORCA_POOL_ADDRESS    =", state.orcaPoolAddress);
  console.log("  BASE_MINT  =", state.baseMint, `(WSOL, ${BASE_DECIMALS}dp)`);
  console.log("  QUOTE_MINT =", state.quoteMint, `(devUSDC, ${QUOTE_DECIMALS}dp)`);
}

main().catch((e) => {
  console.error("seed-devnet-pools failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
