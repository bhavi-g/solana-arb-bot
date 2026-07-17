/**
 * Orchestration: data source -> detect -> build -> execute(gate) -> log.
 * Modules are wired here and nowhere else; none of them import each other
 * across the source/detection/execution/logging boundaries.
 */
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig, type Config } from "./config.js";
import { detect } from "./detect.js";
import {
  applyFeeHeadroom,
  lamportsFeeToQuote,
  resolveBaseFeeLamports,
} from "./fee.js";
import { execute, SendDisabledError, type ExecutorRpc } from "./executor.js";
import { AttemptLogger } from "./logger.js";
import { loadOrCreateKeypair } from "./wallet.js";
import { RateLimiter } from "./datasource/rateLimiter.js";
import type { PriceSource, SnapshotPair } from "./datasource/PriceSource.js";
import { PollingPriceSource } from "./datasource/polling.js";
import { SyntheticPriceSource, SOL_USDC_DEVNET } from "./datasource/synthetic.js";
import { decodeRaydiumCpmmPool, type RaydiumCpmmPoolState } from "./decode/raydiumCpmm.js";
import { decodeWhirlpool, type WhirlpoolState } from "./decode/orcaWhirlpool.js";
import { buildArbTransaction, TOKEN_PROGRAM_ID, type ArbBuildContext } from "./txbuilder/index.js";
import type { Opportunity, PairInfo, PoolSnapshot } from "./types.js";

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
  if (!cfg.sendEnabled) {
    console.log(
      "[main] SHADOW MODE — send path structurally disabled (ADR-0008); " +
        "no real transaction will be submitted",
    );
  }
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
    // ADR-0008 layer 3: in shadow mode the real send capability is never
    // constructed; reaching this thrower means layer 2 was bypassed.
    sendRawTransaction: cfg.sendEnabled
      ? async (raw, options) => {
          await limiter.acquire();
          return connection.sendRawTransaction(
            raw,
            options as Parameters<Connection["sendRawTransaction"]>[1],
          );
        }
      : async () => {
          throw new SendDisabledError(
            "sendRawTransaction invoked in shadow mode — the executor's " +
              "layer-2 guard was bypassed (ADR-0008)",
          );
        },
  };

  const { source, buildMeta, feeLamportsWithHeadroom } = await setUp(
    cfg,
    connection,
    limiter,
    wallet,
  );

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n[main] stopping after current cycle…");
    source.stop();
  });

  await source.run(async (pair: SnapshotPair) => {
    // ADR-0007: the manual override wins; otherwise reprice the fetched fee
    // (already carrying its +20% headroom) to quote units at THIS cycle's
    // live mid price. Fee is subtracted in detect(); the threshold check
    // there stays a separate step and never sees the headroom.
    const estTxFeeQuote =
      cfg.estTxFeeQuote ?? lamportsFeeToQuote(feeLamportsWithHeadroom, pair.cpmm);
    const decision = detect(pair.cpmm, pair.whirlpool, {
      tradeSizeQuote: cfg.tradeSizeQuote,
      minProfitThresholdQuote: cfg.minProfitThresholdQuote,
      slippageToleranceBps: cfg.slippageToleranceBps,
      estTxFeeQuote,
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
      {
        cluster: cfg.cluster,
        dataSource: source.name,
        slot: pair.cpmm.slot,
        sendEnabled: cfg.sendEnabled,
      },
    );
  });

  console.log("[main] source finished; exiting.");
}

interface Setup {
  source: PriceSource;
  /** Produces the txbuilder context for the freshest snapshot pair. */
  buildMeta: (pair: SnapshotPair, blockhash: string) => ArbBuildContext;
  /**
   * Base tx fee in lamports with the ADR-0007 +20% headroom already applied,
   * fetched once at startup. main.ts converts this to quote units per cycle.
   * 0n when a manual EST_TX_FEE_QUOTE override is set (fetch is skipped).
   */
  feeLamportsWithHeadroom: bigint;
}

/**
 * Resolve the startup base fee (lamports) with +20% headroom, per ADR-0007.
 * Builds the ACTUAL arb transaction shape and asks devnet what it would
 * cost via getFeeForMessage; falls back to the protocol constant on any
 * failure. Skipped entirely (returns 0n) when a manual override is set.
 */
async function resolveStartupFeeLamports(
  cfg: Config,
  connection: Connection,
  limiter: RateLimiter,
  buildMeta: (pair: SnapshotPair, blockhash: string) => ArbBuildContext,
  pair: PairInfo,
  sampleTickIndex: number,
): Promise<bigint> {
  if (cfg.estTxFeeQuote !== undefined) {
    console.log(
      `[main] EST_TX_FEE_QUOTE override set (${cfg.estTxFeeQuote}); ` +
        "skipping live fee fetch (ADR-0007).",
    );
    return 0n;
  }

  const sampleOpp: Opportunity = {
    decision: "opportunity",
    direction: { buyOn: "raydium-cpmm", sellOn: "orca-whirlpool" },
    gapBps: 0,
    quoteIn: cfg.tradeSizeQuote,
    baseOut: 1n,
    quoteOut: cfg.tradeSizeQuote,
    estNetProfit: 0n,
    minProfitThreshold: cfg.minProfitThresholdQuote,
  };
  const samplePair = sampleSnapshotPair(pair, sampleTickIndex);

  const fetchFee = async (): Promise<number | null> => {
    await limiter.acquire();
    const { blockhash } = await connection.getLatestBlockhash();
    const ctx = buildMeta(samplePair, blockhash);
    const tx = buildArbTransaction(ctx, sampleOpp);
    await limiter.acquire();
    const resp = await connection.getFeeForMessage(tx.message);
    return resp.value;
  };

  // Our arb tx is signed only by the payer -> 1 signature for the fallback.
  const { lamports, source } = await resolveBaseFeeLamports(fetchFee, 1);
  const withHeadroom = applyFeeHeadroom(lamports);
  console.log(
    `[main] base tx fee ${lamports} lamports (${source}); ` +
      `+20% headroom -> ${withHeadroom} lamports (ADR-0007)`,
  );
  return withHeadroom;
}

/** Minimal snapshot pair used only to shape the sample fee transaction. */
function sampleSnapshotPair(pair: PairInfo, tickIndex: number): SnapshotPair {
  const cpmm: PoolSnapshot = {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "sample",
    pair,
    fetchedAtMs: Date.now(),
    slot: 0,
    source: "fee-sample",
    baseReserve: 1n,
    quoteReserve: 1n,
    feeBps: 25,
  };
  const whirlpool: PoolSnapshot = {
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: "sample",
    pair,
    fetchedAtMs: Date.now(),
    slot: 0,
    source: "fee-sample",
    sqrtPriceX64: 1n,
    liquidity: 1n,
    tickCurrentIndex: tickIndex,
    feeBps: 30,
  };
  return { cpmm, whirlpool };
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

    const buildMeta = (snap: SnapshotPair, blockhash: string): ArbBuildContext => ({
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
    });

    const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
      cfg,
      connection,
      limiter,
      buildMeta,
      pair,
      orcaState.tickCurrentIndex,
    );

    return { source, buildMeta, feeLamportsWithHeadroom };
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

  const buildMeta = (snap: SnapshotPair, blockhash: string): ArbBuildContext => ({
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
  });

  const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
    cfg,
    connection,
    limiter,
    buildMeta,
    SOL_USDC_DEVNET,
    synthOrca.tickCurrentIndex,
  );

  return { source: new SyntheticPriceSource(), buildMeta, feeLamportsWithHeadroom };
}

main().catch((e) => {
  console.error(`[main] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
