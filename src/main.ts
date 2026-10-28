/**
 * Orchestration: data source -> detect -> build -> execute(gate) -> log.
 * Modules are wired here and nowhere else; none of them import each other
 * across the source/detection/execution/logging boundaries.
 */
import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  type VersionedTransaction,
} from "@solana/web3.js";
import { loadConfig, type Config } from "./config.js";
import {
  computeCosts,
  medianCuPriceMicroLamports,
  DEFAULT_CU_PRICE_MICRO_LAMPORTS,
} from "./costs.js";
import {
  applyFeeHeadroom,
  lamportsFeeToQuote,
  resolveBaseFeeLamports,
} from "./fee.js";
import { detectViaRust } from "./rustmath.js";
import { execute, SendDisabledError, type ExecutorRpc } from "./executor.js";
import { AttemptLogger } from "./logger.js";
import { loadOrCreateKeypair } from "./wallet.js";
import { RateLimiter } from "./datasource/rateLimiter.js";
import type { PriceSource, SnapshotPair } from "./datasource/PriceSource.js";
import { PollingPriceSource } from "./datasource/polling.js";
import { OrcaOrcaPollingSource } from "./datasource/orcaOrcaPolling.js";
import {
  createYellowstoneTransport,
  GeyserPriceSource,
} from "./datasource/geyser.js";
import { SyntheticPriceSource, SOL_USDC_DEVNET } from "./datasource/synthetic.js";
import { decodeRaydiumCpmmPool, type RaydiumCpmmPoolState } from "./decode/raydiumCpmm.js";
import { decodeWhirlpool, type WhirlpoolState } from "./decode/orcaWhirlpool.js";
import { buildArbTransaction, TOKEN_PROGRAM_ID, type ArbBuildContext } from "./txbuilder/index.js";
import {
  buildTwoWhirlpoolArbTransaction,
  type TwoWhirlpoolBuildContext,
} from "./txbuilder/twoWhirlpool.js";
import { ClmmOrcaPollingSource } from "./datasource/clmmOrcaPolling.js";
import {
  buildClmmOrcaArbTransaction,
  type ClmmOrcaBuildContext,
} from "./txbuilder/clmmOrca.js";
import { decodeClmmPool, decodeClmmAmmConfigFeeBps } from "./decode/clmm.js";
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

  // ADR-0009: live CU price, cached 30s so it doesn't eat the RPS budget.
  const CU_PRICE_TTL_MS = 30_000;
  let cuPriceCache = { value: DEFAULT_CU_PRICE_MICRO_LAMPORTS, fetchedAtMs: 0 };
  const currentCuPrice = async (): Promise<bigint> => {
    if (Date.now() - cuPriceCache.fetchedAtMs < CU_PRICE_TTL_MS) {
      return cuPriceCache.value;
    }
    try {
      await limiter.acquire();
      const fees = await connection.getRecentPrioritizationFees();
      cuPriceCache = {
        value: medianCuPriceMicroLamports(fees),
        fetchedAtMs: Date.now(),
      };
    } catch {
      cuPriceCache = { ...cuPriceCache, fetchedAtMs: Date.now() }; // keep last
    }
    return cuPriceCache.value;
  };

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

  const { source, buildTx, feeLamportsWithHeadroom } = await setUp(
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
    const detectStart = performance.now();
    const decision = detectViaRust(pair.cpmm, pair.whirlpool, {
      tradeSizeQuote: cfg.tradeSizeQuote,
      minProfitThresholdQuote: cfg.minProfitThresholdQuote,
      slippageToleranceBps: cfg.slippageToleranceBps,
      estTxFeeQuote,
    });
    // Detection-latency instrumentation (Phase-2 deliverable): handoffMs is
    // the acquisition→decision latency (time from when we started fetching
    // the freshest input to the decision being ready — RPC round-trip +
    // decode + detect for polling; ~0 for a push source). It is NOT chain
    // staleness: it does not include poll-interval sampling lag.
    const latency = {
      handoffMs:
        Date.now() -
        Math.max(pair.cpmm.fetchStartedAtMs, pair.whirlpool.fetchStartedAtMs),
      detectComputeMs: performance.now() - detectStart,
    };

    if (decision.decision === "no-opportunity") {
      logger.record({
        timestamp: new Date().toISOString(),
        cluster: cfg.cluster,
        dataSource: source.name,
        slot: pair.cpmm.slot,
        gapBps: decision.gapBps,
        decision: decision.decision,
        reason: decision.reason,
        detail: { latency },
      });
      return;
    }

    await limiter.acquire();
    const { blockhash } = await connection.getLatestBlockhash();
    const cuPriceNow = await currentCuPrice();
    await execute(
      gatedRpc,
      (cuLimit) => buildTx(pair, blockhash, decision, cuLimit),
      decision,
      logger,
      {
        cluster: cfg.cluster,
        dataSource: source.name,
        slot: pair.cpmm.slot,
        sendEnabled: cfg.sendEnabled,
        latency,
        computeCosts: (cuLimit) =>
          computeCosts(
            {
              grossProfitQuote: decision.quoteOut - decision.quoteIn,
              baseFeeQuote: estTxFeeQuote,
              cuPriceMicroLamports: cuPriceNow,
              jitoTipFractionBps: cfg.jitoTipFractionBps,
              priceRef: pair.cpmm,
            },
            cuLimit,
          ),
      },
    );
  });

  console.log("[main] source finished; exiting.");
}

/**
 * Builds the arb transaction for the freshest snapshot pair. Encapsulates
 * the venue-specific context + builder (CPMM-vs-Orca or two-Orca), so the
 * run loop and fee sampler stay venue-agnostic.
 */
type BuildTx = (
  pair: SnapshotPair,
  blockhash: string,
  opp: Opportunity,
  cuLimit?: number,
) => VersionedTransaction;

interface Setup {
  source: PriceSource;
  buildTx: BuildTx;
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
  buildSampleTx: (blockhash: string) => VersionedTransaction,
): Promise<bigint> {
  if (cfg.estTxFeeQuote !== undefined) {
    console.log(
      `[main] EST_TX_FEE_QUOTE override set (${cfg.estTxFeeQuote}); ` +
        "skipping live fee fetch (ADR-0007).",
    );
    return 0n;
  }

  const fetchFee = async (): Promise<number | null> => {
    await limiter.acquire();
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = buildSampleTx(blockhash);
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

/** Sample opportunity used only to shape the fee-estimate transaction. */
function sampleOpportunity(
  cfg: Config,
  buyPoolAddress?: string,
  sellPoolAddress?: string,
): Opportunity {
  return {
    decision: "opportunity",
    direction: {
      buyOn: "raydium-cpmm",
      sellOn: "orca-whirlpool",
      ...(buyPoolAddress ? { buyPoolAddress } : {}),
      ...(sellPoolAddress ? { sellPoolAddress } : {}),
    },
    gapBps: 0,
    quoteIn: cfg.tradeSizeQuote,
    baseOut: 1n,
    quoteOut: cfg.tradeSizeQuote,
    estNetProfit: 0n,
    minProfitThreshold: cfg.minProfitThresholdQuote,
  };
}

/** Minimal snapshot pair used only to shape the sample fee transaction. */
function sampleSnapshotPair(pair: PairInfo, tickIndex: number): SnapshotPair {
  const cpmm: PoolSnapshot = {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "sample",
    pair,
    fetchStartedAtMs: Date.now(),
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
    fetchStartedAtMs: Date.now(),
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

  // Shadow mode simulates as a live-discovered funded surrogate so
  // simulation results reflect the strategy, not our unfunded wallet.
  // The resulting tx is UNSIGNED (see the txbuilder payer union).
  const buildPayer: Keypair | PublicKey =
    !cfg.sendEnabled && cfg.surrogateOwner
      ? new PublicKey(cfg.surrogateOwner)
      : wallet;
  if (!cfg.sendEnabled && cfg.dataSource !== "synthetic" && !cfg.surrogateOwner) {
    console.log(
      "[main] WARNING: shadow mode without SURROGATE_OWNER — simulations " +
        "will fail on wallet errors (unfunded local wallet)",
    );
  }

  if (cfg.dataSource === "polling" || cfg.dataSource === "geyser") {
    const pair = {
      baseMint: cfg.baseMint!,
      quoteMint: cfg.quoteMint!,
      baseDecimals: cfg.baseDecimals!,
      quoteDecimals: cfg.quoteDecimals!,
    };

    if (cfg.venue === "orca-orca") {
      return setUpOrcaOrca(cfg, connection, limiter, buildPayer, orcaProgramId, pair);
    }

    if (cfg.venue === "clmm-orca") {
      return setUpClmmOrca(cfg, connection, limiter, buildPayer, orcaProgramId, pair);
    }

    // venue = cpmm-orca (Raydium CPMM vs Orca Whirlpool).
    const source: PriceSource =
      cfg.dataSource === "geyser"
        ? new GeyserPriceSource(
            await createYellowstoneTransport(cfg.geyserEndpoint!, cfg.geyserXToken),
            {
              raydiumPoolAddress: cfg.raydiumPoolAddress!,
              orcaPoolAddress: cfg.orcaPoolAddress!,
              pair,
              decodeCpmm: () => {
                // CPMM reserves live in vault token accounts, not the pool
                // account; a runnable Geyser build must also subscribe both
                // vaults, which needs a live endpoint to verify honestly.
                // Deliberate Phase-2 code-only gap (see geyser.ts header).
                throw new Error(
                  "geyser vault subscription not wired — see src/datasource/geyser.ts",
                );
              },
              decodeWhirl: (data) => {
                const s = decodeWhirlpool(Buffer.from(data));
                return {
                  sqrtPriceX64: s.sqrtPriceX64,
                  liquidity: s.liquidity,
                  tickCurrentIndex: s.tickCurrentIndex,
                  feeBps: s.feeBps,
                };
              },
            },
          )
        : new PollingPriceSource(
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

    const makeCtx = (snap: SnapshotPair, blockhash: string): ArbBuildContext => ({
      payer: buildPayer,
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
    const buildTx: BuildTx = (snap, blockhash, opp, cuLimit) =>
      buildArbTransaction(makeCtx(snap, blockhash), opp, cuLimit);

    const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
      cfg,
      connection,
      limiter,
      (blockhash) =>
        buildTx(
          sampleSnapshotPair(pair, orcaState.tickCurrentIndex),
          blockhash,
          sampleOpportunity(cfg),
        ),
    );

    return { source, buildTx, feeLamportsWithHeadroom };
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

  const makeSynthCtx = (snap: SnapshotPair, blockhash: string): ArbBuildContext => ({
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
  const buildTx: BuildTx = (snap, blockhash, opp, cuLimit) =>
    buildArbTransaction(makeSynthCtx(snap, blockhash), opp, cuLimit);

  const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
    cfg,
    connection,
    limiter,
    (blockhash) =>
      buildTx(
        sampleSnapshotPair(SOL_USDC_DEVNET, synthOrca.tickCurrentIndex),
        blockhash,
        sampleOpportunity(cfg),
      ),
  );

  return { source: new SyntheticPriceSource(), buildTx, feeLamportsWithHeadroom };
}

/**
 * Two-Orca venue setup (Phase-2 interim). Polls two whirlpools and builds
 * two-whirlpool arb transactions. Geyser is not wired for this venue yet.
 */
async function setUpOrcaOrca(
  cfg: Config,
  connection: Connection,
  limiter: RateLimiter,
  buildPayer: Keypair | PublicKey,
  orcaProgramId: PublicKey,
  pair: PairInfo,
): Promise<Setup> {
  if (cfg.dataSource === "geyser") {
    throw new Error(
      "VENUE=orca-orca is only wired for DATA_SOURCE=polling (a two-whirlpool " +
        "Geyser source is not implemented yet)",
    );
  }

  const poolA = new PublicKey(cfg.orcaPoolAddress!);
  const poolB = new PublicKey(cfg.orcaPoolAddressB!);
  const source = new OrcaOrcaPollingSource(
    connection,
    {
      whirlpoolAAddress: poolA.toBase58(),
      whirlpoolBAddress: poolB.toBase58(),
      pair,
      pollIntervalMs: cfg.pollIntervalMs,
    },
    limiter,
  );

  await limiter.acquire();
  const [accA, accB] = await connection.getMultipleAccountsInfo([poolA, poolB]);
  if (!accA || !accB) {
    throw new Error("configured orca-orca pool accounts not found on this cluster");
  }
  const stateA = decodeWhirlpool(accA.data);
  const stateB = decodeWhirlpool(accB.data);

  const makeCtx = (
    snap: SnapshotPair,
    blockhash: string,
  ): TwoWhirlpoolBuildContext => ({
    payer: buildPayer,
    recentBlockhash: blockhash,
    pair,
    whirlpoolA: {
      programId: orcaProgramId,
      poolAddress: poolA,
      state: stateA,
      tickCurrentIndex:
        snap.cpmm.kind === "whirlpool" ? snap.cpmm.tickCurrentIndex : stateA.tickCurrentIndex,
    },
    whirlpoolB: {
      programId: orcaProgramId,
      poolAddress: poolB,
      state: stateB,
      tickCurrentIndex:
        snap.whirlpool.kind === "whirlpool"
          ? snap.whirlpool.tickCurrentIndex
          : stateB.tickCurrentIndex,
    },
  });
  const buildTx: BuildTx = (snap, blockhash, opp, cuLimit) =>
    buildTwoWhirlpoolArbTransaction(makeCtx(snap, blockhash), opp, cuLimit);

  const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
    cfg,
    connection,
    limiter,
    (blockhash) =>
      buildTx(
        sampleSnapshotPair(pair, stateA.tickCurrentIndex),
        blockhash,
        sampleOpportunity(cfg, poolA.toBase58(), poolB.toBase58()),
      ),
  );

  console.log(
    `[main] VENUE=orca-orca: ${poolA.toBase58()} (fee ${stateA.feeBps}bps) vs ` +
      `${poolB.toBase58()} (fee ${stateB.feeBps}bps)`,
  );
  return { source, buildTx, feeLamportsWithHeadroom };
}

/**
 * clmm-orca cross-DEX venue setup (Phase-2). Polls one Raydium CLMM pool +
 * one Orca whirlpool and builds atomic CLMM+Orca arb transactions. The CLMM
 * fee lives in the referenced AmmConfig (not the pool account) and is
 * effectively static, so it is resolved ONCE here at startup and injected
 * into the polling source. Geyser is not wired for this venue.
 */
async function setUpClmmOrca(
  cfg: Config,
  connection: Connection,
  limiter: RateLimiter,
  buildPayer: Keypair | PublicKey,
  orcaProgramId: PublicKey,
  pair: PairInfo,
): Promise<Setup> {
  if (cfg.dataSource === "geyser") {
    throw new Error(
      "VENUE=clmm-orca is only wired for DATA_SOURCE=polling (a heterogeneous " +
        "CLMM+Orca Geyser source is not implemented yet)",
    );
  }

  const clmmProgramId = new PublicKey(cfg.raydiumClmmProgramId);
  const clmmPool = new PublicKey(cfg.clmmPoolAddress!);
  const orcaPool = new PublicKey(cfg.orcaPoolAddress!);

  // Startup reads: CLMM pool (for static state) + Orca whirlpool.
  await limiter.acquire();
  const [clmmAcc, orcaAcc] = await connection.getMultipleAccountsInfo([
    clmmPool,
    orcaPool,
  ]);
  if (!clmmAcc || !orcaAcc) {
    throw new Error("configured clmm-orca pool accounts not found on this cluster");
  }
  const clmmState = decodeClmmPool(clmmAcc.data);
  const orcaState = decodeWhirlpool(orcaAcc.data);

  // CLMM fee lives in the referenced AmmConfig — read it once here.
  await limiter.acquire();
  const ammConfigAcc = await connection.getAccountInfo(clmmState.ammConfig);
  if (!ammConfigAcc) {
    throw new Error(`CLMM AmmConfig ${clmmState.ammConfig.toBase58()} not found`);
  }
  const clmmFeeBps = decodeClmmAmmConfigFeeBps(ammConfigAcc.data);

  const source = new ClmmOrcaPollingSource(
    connection,
    {
      clmmPoolAddress: clmmPool.toBase58(),
      whirlpoolAddress: orcaPool.toBase58(),
      pair,
      pollIntervalMs: cfg.pollIntervalMs,
      clmmFeeBps,
    },
    limiter,
  );

  const makeCtx = (
    snap: SnapshotPair,
    blockhash: string,
  ): ClmmOrcaBuildContext => ({
    payer: buildPayer,
    recentBlockhash: blockhash,
    pair,
    clmm: {
      programId: clmmProgramId,
      poolAddress: clmmPool,
      state: clmmState,
      tickCurrentIndex:
        snap.cpmm.kind === "whirlpool" ? snap.cpmm.tickCurrentIndex : clmmState.tickCurrentIndex,
    },
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
  const buildTx: BuildTx = (snap, blockhash, opp, cuLimit) =>
    buildClmmOrcaArbTransaction(makeCtx(snap, blockhash), opp, cuLimit);

  const feeLamportsWithHeadroom = await resolveStartupFeeLamports(
    cfg,
    connection,
    limiter,
    (blockhash) =>
      buildTx(
        sampleSnapshotPair(pair, orcaState.tickCurrentIndex),
        blockhash,
        sampleOpportunity(cfg),
      ),
  );

  console.log(
    `[main] VENUE=clmm-orca: CLMM ${clmmPool.toBase58()} (fee ${clmmFeeBps}bps) vs ` +
      `Orca ${orcaPool.toBase58()} (fee ${orcaState.feeBps}bps)`,
  );
  return { source, buildTx, feeLamportsWithHeadroom };
}

main().catch((e) => {
  console.error(`[main] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
