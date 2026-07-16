/**
 * Orchestration: data source -> detect -> build -> execute(gate) -> log.
 * Modules are wired here and nowhere else; none of them import each other
 * across the source/detection/execution/logging boundaries.
 */
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig, type Config } from "./config.js";
import { detect } from "./detect.js";
import { execute, type ExecutorRpc } from "./executor.js";
import { AttemptLogger } from "./logger.js";
import { loadOrCreateKeypair } from "./wallet.js";
import { RateLimiter } from "./datasource/rateLimiter.js";
import type { PriceSource, SnapshotPair } from "./datasource/PriceSource.js";
import { PollingPriceSource } from "./datasource/polling.js";
import { SyntheticPriceSource, SOL_USDC_DEVNET } from "./datasource/synthetic.js";
import { decodeRaydiumCpmmPool, type RaydiumCpmmPoolState } from "./decode/raydiumCpmm.js";
import { decodeWhirlpool, type WhirlpoolState } from "./decode/orcaWhirlpool.js";
import { buildArbTransaction, TOKEN_PROGRAM_ID, type ArbBuildContext } from "./txbuilder/index.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  console.log(
    `[main] phase=${cfg.phase} cluster=${cfg.cluster} dataSource=${cfg.dataSource} ` +
      `commitment=${cfg.commitment} maxRps=${cfg.maxRps} ` +
      `tradeSize=${cfg.tradeSizeQuote} minProfit=${cfg.minProfitThresholdQuote}`,
  );

  const connection = new Connection(cfg.rpcUrl, cfg.commitment);
  const wallet = loadOrCreateKeypair(cfg.keypairPath);
  console.log(`[main] wallet ${wallet.publicKey.toBase58()}`);
  const logger = new AttemptLogger();
  const limiter = new RateLimiter(cfg.maxRps);

  // Every RPC call the executor makes also counts against the budget.
  const gatedRpc: ExecutorRpc = {
    simulateTransaction: async (tx, config) => {
      await limiter.acquire();
      // The gate simulates the exact VersionedTransaction it will send.
      return connection.simulateTransaction(
        tx as Parameters<Connection["simulateTransaction"]>[0],
        config as Parameters<Connection["simulateTransaction"]>[1],
      );
    },
    sendRawTransaction: async (raw, options) => {
      await limiter.acquire();
      return connection.sendRawTransaction(
        raw,
        options as Parameters<Connection["sendRawTransaction"]>[1],
      );
    },
  };

  const { source, buildMeta } = await setUp(cfg, connection, limiter, wallet);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n[main] stopping after current cycle…");
    source.stop();
  });

  await source.run(async (pair: SnapshotPair) => {
    const decision = detect(pair.cpmm, pair.whirlpool, {
      tradeSizeQuote: cfg.tradeSizeQuote,
      minProfitThresholdQuote: cfg.minProfitThresholdQuote,
      slippageToleranceBps: cfg.slippageToleranceBps,
      estTxFeeQuote: cfg.estTxFeeQuote,
    });

    if (decision.decision === "no-opportunity") {
      logger.record({
        timestamp: new Date().toISOString(),
        cluster: cfg.cluster,
        dataSource: source.name,
        slot: pair.cpmm.slot,
        gapBps: decision.gapBps,
        decision: decision.decision,
        reason: decision.reason,
      });
      return;
    }

    await limiter.acquire();
    const { blockhash } = await connection.getLatestBlockhash();
    const ctx = buildMeta(pair, blockhash);
    await execute(
      gatedRpc,
      (cuLimit) => buildArbTransaction(ctx, decision, cuLimit),
      decision,
      logger,
      { cluster: cfg.cluster, dataSource: source.name, slot: pair.cpmm.slot },
    );
  });

  console.log("[main] source finished; exiting.");
}

interface Setup {
  source: PriceSource;
  /** Produces the txbuilder context for the freshest snapshot pair. */
  buildMeta: (pair: SnapshotPair, blockhash: string) => ArbBuildContext;
}

async function setUp(
  cfg: Config,
  connection: Connection,
  limiter: RateLimiter,
  wallet: Keypair,
): Promise<Setup> {
  const raydiumProgramId = new PublicKey(cfg.raydiumProgramId);
  const orcaProgramId = new PublicKey(cfg.orcaProgramId);

  if (cfg.dataSource === "polling") {
    const pair = {
      baseMint: cfg.baseMint!,
      quoteMint: cfg.quoteMint!,
      baseDecimals: cfg.baseDecimals!,
      quoteDecimals: cfg.quoteDecimals!,
    };
    const source = new PollingPriceSource(
      connection,
      {
        raydiumPoolAddress: cfg.raydiumPoolAddress!,
        orcaPoolAddress: cfg.orcaPoolAddress!,
        pair,
        pollIntervalMs: cfg.pollIntervalMs,
      },
      limiter,
    );

    // Static pool metadata for the tx builder, fetched once.
    const raydiumPool = new PublicKey(cfg.raydiumPoolAddress!);
    const orcaPool = new PublicKey(cfg.orcaPoolAddress!);
    await limiter.acquire();
    const [rayAcc, orcaAcc] = await connection.getMultipleAccountsInfo([
      raydiumPool,
      orcaPool,
    ]);
    if (!rayAcc || !orcaAcc) {
      throw new Error("configured pool accounts not found on this cluster");
    }
    const rayState = decodeRaydiumCpmmPool(rayAcc.data);
    const orcaState = decodeWhirlpool(orcaAcc.data);

    return {
      source,
      buildMeta: (snap, blockhash) => ({
        payer: wallet,
        recentBlockhash: blockhash,
        pair,
        raydium: { programId: raydiumProgramId, poolAddress: raydiumPool, state: rayState },
        whirlpool: {
          programId: orcaProgramId,
          poolAddress: orcaPool,
          state: orcaState,
          tickCurrentIndex:
            snap.whirlpool.kind === "whirlpool"
              ? snap.whirlpool.tickCurrentIndex
              : orcaState.tickCurrentIndex,
        },
      }),
    };
  }

  // Synthetic mode: pool metadata is generated (the pools do not exist on
  // chain), so the mandatory simulation will FAIL against the real cluster
  // and the executor's abort path runs on REAL simulation output. Nothing
  // is fabricated — this proves detect -> build -> simulate -> abort -> log.
  const synthRay: RaydiumCpmmPoolState = {
    ammConfig: Keypair.generate().publicKey,
    token0Vault: Keypair.generate().publicKey,
    token1Vault: Keypair.generate().publicKey,
    token0Mint: new PublicKey(SOL_USDC_DEVNET.baseMint),
    token1Mint: new PublicKey(SOL_USDC_DEVNET.quoteMint),
    token0Program: TOKEN_PROGRAM_ID,
    token1Program: TOKEN_PROGRAM_ID,
    observationKey: Keypair.generate().publicKey,
    mint0Decimals: SOL_USDC_DEVNET.baseDecimals,
    mint1Decimals: SOL_USDC_DEVNET.quoteDecimals,
    feesToken0: 0n,
    feesToken1: 0n,
  };
  const synthOrca: WhirlpoolState = {
    sqrtPriceX64: 7_144_247_248_808_263_680n,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    tickSpacing: 64,
    feeBps: 30,
    tokenMintA: new PublicKey(SOL_USDC_DEVNET.baseMint),
    tokenMintB: new PublicKey(SOL_USDC_DEVNET.quoteMint),
    tokenVaultA: Keypair.generate().publicKey,
    tokenVaultB: Keypair.generate().publicKey,
  };
  const synthRayPool = Keypair.generate().publicKey;
  const synthOrcaPool = Keypair.generate().publicKey;

  return {
    source: new SyntheticPriceSource(),
    buildMeta: (snap, blockhash) => ({
      payer: wallet,
      recentBlockhash: blockhash,
      pair: SOL_USDC_DEVNET,
      raydium: { programId: raydiumProgramId, poolAddress: synthRayPool, state: synthRay },
      whirlpool: {
        programId: orcaProgramId,
        poolAddress: synthOrcaPool,
        state: synthOrca,
        tickCurrentIndex:
          snap.whirlpool.kind === "whirlpool"
            ? snap.whirlpool.tickCurrentIndex
            : synthOrca.tickCurrentIndex,
      },
    }),
  };
}

main().catch((e) => {
  console.error(`[main] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
