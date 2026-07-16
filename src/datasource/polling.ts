/**
 * PollingPriceSource: fills the PriceSource contract by polling account
 * state over JSON-RPC (data roadmap stage 1; ADR-0006).
 *
 * Request budget: one getMultipleAccounts per cycle (Raydium pool + its
 * two vaults + the Whirlpool), plus two one-time fetches at startup
 * (Raydium PoolState for vault addresses, AmmConfig for the trade fee).
 * Every request passes through the sliding-window rate limiter.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler } from "./PriceSource.js";
import { RateLimiter } from "./rateLimiter.js";
import {
  decodeAmmConfigFeeBps,
  decodeRaydiumCpmmPool,
  decodeTokenAccountAmount,
  type RaydiumCpmmPoolState,
} from "../decode/raydiumCpmm.js";
import { decodeWhirlpool } from "../decode/orcaWhirlpool.js";

export interface PollingConfig {
  raydiumPoolAddress: string;
  orcaPoolAddress: string;
  pair: PairInfo;
  pollIntervalMs: number;
}

export class PollingPriceSource implements PriceSource {
  readonly name = "polling";
  private stopped = false;

  constructor(
    private readonly connection: Connection,
    private readonly cfg: PollingConfig,
    private readonly limiter: RateLimiter,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    const raydiumPool = new PublicKey(this.cfg.raydiumPoolAddress);
    const orcaPool = new PublicKey(this.cfg.orcaPoolAddress);

    const poolState = decodeRaydiumCpmmPool(
      await this.fetchAccount(raydiumPool, "Raydium pool"),
    );
    this.checkCpmmOrientation(poolState);
    const raydiumFeeBps = decodeAmmConfigFeeBps(
      await this.fetchAccount(poolState.ammConfig, "Raydium AmmConfig"),
    );

    while (!this.stopped) {
      const cycleStart = Date.now();
      try {
        const pair = await this.pollOnce(
          raydiumPool,
          orcaPool,
          poolState,
          raydiumFeeBps,
        );
        await onPair(pair);
      } catch (e) {
        this.noteFailure(e);
      }
      const elapsed = Date.now() - cycleStart;
      const wait = Math.max(0, this.cfg.pollIntervalMs - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async pollOnce(
    raydiumPool: PublicKey,
    orcaPool: PublicKey,
    poolState: RaydiumCpmmPoolState,
    raydiumFeeBps: number,
  ) {
    await this.limiter.acquire();
    const { context, value } =
      await this.connection.getMultipleAccountsInfoAndContext([
        raydiumPool,
        poolState.token0Vault,
        poolState.token1Vault,
        orcaPool,
      ]);
    this.limiter.notifySuccess();

    const [poolAcc, vault0Acc, vault1Acc, orcaAcc] = value;
    if (!poolAcc || !vault0Acc || !vault1Acc || !orcaAcc) {
      throw new Error("one or more watched accounts not found on this cluster");
    }

    // Re-decode pool state each cycle: accrued fees move with every swap.
    const pool = decodeRaydiumCpmmPool(poolAcc.data);
    const vault0 = decodeTokenAccountAmount(vault0Acc.data) - pool.feesToken0;
    const vault1 = decodeTokenAccountAmount(vault1Acc.data) - pool.feesToken1;

    const baseIsToken0 = pool.token0Mint.toBase58() === this.cfg.pair.baseMint;
    const now = Date.now();

    const cpmm: PoolSnapshot = {
      kind: "cpmm",
      dex: "raydium-cpmm",
      poolAddress: raydiumPool.toBase58(),
      pair: this.cfg.pair,
      fetchedAtMs: now,
      slot: context.slot,
      source: this.name,
      baseReserve: baseIsToken0 ? vault0 : vault1,
      quoteReserve: baseIsToken0 ? vault1 : vault0,
      feeBps: raydiumFeeBps,
    };

    const whirl = decodeWhirlpool(orcaAcc.data);
    if (
      whirl.tokenMintA.toBase58() !== this.cfg.pair.baseMint ||
      whirl.tokenMintB.toBase58() !== this.cfg.pair.quoteMint
    ) {
      throw new Error(
        "Whirlpool token orientation mismatch: Phase 1 requires tokenMintA=base, tokenMintB=quote " +
          `(pool has A=${whirl.tokenMintA.toBase58()} B=${whirl.tokenMintB.toBase58()})`,
      );
    }
    const whirlpool: PoolSnapshot = {
      kind: "whirlpool",
      dex: "orca-whirlpool",
      poolAddress: orcaPool.toBase58(),
      pair: this.cfg.pair,
      fetchedAtMs: now,
      slot: context.slot,
      source: this.name,
      sqrtPriceX64: whirl.sqrtPriceX64,
      liquidity: whirl.liquidity,
      tickCurrentIndex: whirl.tickCurrentIndex,
      feeBps: whirl.feeBps,
    };

    return { cpmm, whirlpool };
  }

  private async fetchAccount(
    address: PublicKey,
    label: string,
  ): Promise<Uint8Array> {
    await this.limiter.acquire();
    try {
      const info = await this.connection.getAccountInfo(address);
      if (!info) throw new Error(`${label} account not found: ${address.toBase58()}`);
      this.limiter.notifySuccess();
      return info.data;
    } catch (e) {
      this.noteFailure(e);
      throw e;
    }
  }

  private checkCpmmOrientation(pool: RaydiumCpmmPoolState): void {
    const mints = [pool.token0Mint.toBase58(), pool.token1Mint.toBase58()];
    if (
      !mints.includes(this.cfg.pair.baseMint) ||
      !mints.includes(this.cfg.pair.quoteMint)
    ) {
      throw new Error(
        `Raydium pool mints ${mints.join(", ")} do not match configured pair ` +
          `${this.cfg.pair.baseMint}/${this.cfg.pair.quoteMint}`,
      );
    }
  }

  private noteFailure(e: unknown): void {
    const msg = String(e);
    if (msg.includes("429") || msg.includes("-32429")) {
      this.limiter.notifyRateLimited();
      console.warn(`[polling] rate limited, backing off: ${msg}`);
    } else {
      console.warn(`[polling] cycle failed: ${msg}`);
    }
  }
}
