/**
 * ClmmOrcaPollingSource: polls one Raydium CLMM pool and one Orca
 * whirlpool (same SOL/USDC pair) per cycle and emits a SnapshotPair
 * (ADR-0006). Phase-2 clmm-orca cross-DEX shadow venue — the venue that
 * can finally produce a real go/no-go signal (the two-Orca interim could
 * not; see docs/phases/phase-2-mainnet-shadow-mode.md).
 *
 * The SnapshotPair slots are cosmetic (as in orcaOrcaPolling.ts): the CLMM
 * fills the `cpmm` slot, the whirlpool fills the `whirlpool` slot;
 * detection/fee/cost math take a generic PoolSnapshot regardless of kind.
 *
 * CLMM's fee lives in the referenced AmmConfig, not the pool account, and
 * is effectively static — so it is resolved ONCE at startup (in main.ts's
 * setUpClmmOrca) and injected here as `clmmFeeBps`; this source never reads
 * the AmmConfig. One getMultipleAccounts per cycle (CLMM pool + whirlpool).
 */
import { PublicKey } from "@solana/web3.js";
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";
import { RateLimiter } from "./rateLimiter.js";
import {
  decodeClmmPool,
  toClmmSnapshot,
  type ClmmPoolState,
} from "../decode/clmm.js";
import { decodeWhirlpool, type WhirlpoolState } from "../decode/orcaWhirlpool.js";

export interface ClmmOrcaConfig {
  clmmPoolAddress: string;
  whirlpoolAddress: string;
  pair: PairInfo;
  pollIntervalMs: number;
  /** CLMM trade fee in bps, resolved once at startup from the AmmConfig. */
  clmmFeeBps: number;
}

/** Minimal RPC slice used here (real Connection satisfies it; fakeable). */
export interface AccountBatchFetcher {
  getMultipleAccountsInfoAndContext(
    keys: PublicKey[],
  ): Promise<{
    context: { slot: number };
    value: Array<{ data: Uint8Array } | null>;
  }>;
}

export type ClmmDecoder = (data: Uint8Array) => ClmmPoolState;
export type WhirlpoolDecoder = (data: Uint8Array) => WhirlpoolState;

export class ClmmOrcaPollingSource implements PriceSource {
  readonly name = "polling";
  private stopped = false;

  constructor(
    private readonly fetcher: AccountBatchFetcher,
    private readonly cfg: ClmmOrcaConfig,
    private readonly limiter: RateLimiter,
    private readonly decodeClmm: ClmmDecoder = decodeClmmPool,
    private readonly decodeWhirl: WhirlpoolDecoder = decodeWhirlpool,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    const clmm = new PublicKey(this.cfg.clmmPoolAddress);
    const orca = new PublicKey(this.cfg.whirlpoolAddress);

    while (!this.stopped) {
      const cycleStart = Date.now();
      try {
        await this.limiter.acquire();
        // Stamp acquisition-start BEFORE the RPC so handoffMs captures the
        // round-trip; both legs come from this one batch read.
        const fetchStartedAtMs = Date.now();
        const { context, value } =
          await this.fetcher.getMultipleAccountsInfoAndContext([clmm, orca]);
        this.limiter.notifySuccess();
        const [clmmAcc, orcaAcc] = value;
        if (!clmmAcc || !orcaAcc) {
          throw new Error("CLMM pool or whirlpool not found on this cluster");
        }
        const clmmSnap = toClmmSnapshot(
          this.decodeClmm(clmmAcc.data),
          this.cfg.clmmFeeBps,
          {
            poolAddress: clmm.toBase58(),
            pair: this.cfg.pair,
            slot: context.slot,
            source: this.name,
            fetchStartedAtMs,
          },
        );
        const pair: SnapshotPair = {
          cpmm: clmmSnap,
          whirlpool: this.orcaSnapshot(
            orca,
            this.decodeWhirl(orcaAcc.data),
            context.slot,
            fetchStartedAtMs,
          ),
        };
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

  private orcaSnapshot(
    address: PublicKey,
    w: WhirlpoolState,
    slot: number,
    fetchStartedAtMs: number,
  ): PoolSnapshot {
    if (
      w.tokenMintA.toBase58() !== this.cfg.pair.baseMint ||
      w.tokenMintB.toBase58() !== this.cfg.pair.quoteMint
    ) {
      throw new Error(
        `Whirlpool ${address.toBase58()} orientation mismatch: expected ` +
          `A=${this.cfg.pair.baseMint} B=${this.cfg.pair.quoteMint}`,
      );
    }
    return {
      kind: "whirlpool",
      dex: "orca-whirlpool",
      poolAddress: address.toBase58(),
      pair: this.cfg.pair,
      fetchStartedAtMs,
      slot,
      source: this.name,
      sqrtPriceX64: w.sqrtPriceX64,
      liquidity: w.liquidity,
      tickCurrentIndex: w.tickCurrentIndex,
      feeBps: w.feeBps,
    };
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
