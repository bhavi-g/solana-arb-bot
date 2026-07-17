/**
 * OrcaOrcaPollingSource: polls two Orca SOL/USDC whirlpools per cycle and
 * emits a SnapshotPair (ADR-0006). Phase-2 two-Orca shadow venue — a
 * documented interim until a Raydium CLMM decoder restores true cross-DEX
 * arbitrage (see docs/phases/phase-2-mainnet-shadow-mode.md).
 *
 * Both pools are whirlpools, so both fill the SnapshotPair's slots (`cpmm`
 * = venue A, `whirlpool` = venue B — the field names are legacy from the
 * CPMM-vs-Orca layout; detection/fee/cost math take a generic PoolSnapshot
 * regardless of kind, so the labels are cosmetic here). One
 * getMultipleAccounts per cycle; no vault reads (whirlpool detection uses
 * sqrtPrice + fee, not reserves).
 */
import { PublicKey } from "@solana/web3.js";
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";
import { RateLimiter } from "./rateLimiter.js";
import { decodeWhirlpool, type WhirlpoolState } from "../decode/orcaWhirlpool.js";

export interface OrcaOrcaConfig {
  whirlpoolAAddress: string;
  whirlpoolBAddress: string;
  pair: PairInfo;
  pollIntervalMs: number;
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

export type WhirlpoolDecoder = (data: Uint8Array) => WhirlpoolState;

export class OrcaOrcaPollingSource implements PriceSource {
  readonly name = "polling";
  private stopped = false;

  constructor(
    private readonly fetcher: AccountBatchFetcher,
    private readonly cfg: OrcaOrcaConfig,
    private readonly limiter: RateLimiter,
    private readonly decode: WhirlpoolDecoder = decodeWhirlpool,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    const a = new PublicKey(this.cfg.whirlpoolAAddress);
    const b = new PublicKey(this.cfg.whirlpoolBAddress);

    while (!this.stopped) {
      const cycleStart = Date.now();
      try {
        await this.limiter.acquire();
        const { context, value } =
          await this.fetcher.getMultipleAccountsInfoAndContext([a, b]);
        this.limiter.notifySuccess();
        const [accA, accB] = value;
        if (!accA || !accB) {
          throw new Error("one or both watched whirlpools not found on this cluster");
        }
        const pair: SnapshotPair = {
          cpmm: this.snapshot(a, this.decode(accA.data), context.slot),
          whirlpool: this.snapshot(b, this.decode(accB.data), context.slot),
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

  private snapshot(
    address: PublicKey,
    w: WhirlpoolState,
    slot: number,
  ): PoolSnapshot {
    if (
      w.tokenMintA.toBase58() !== this.cfg.pair.baseMint ||
      w.tokenMintB.toBase58() !== this.cfg.pair.quoteMint
    ) {
      throw new Error(
        `Whirlpool ${address.toBase58()} orientation mismatch: expected ` +
          `A=${this.cfg.pair.baseMint} B=${this.cfg.pair.quoteMint}, got ` +
          `A=${w.tokenMintA.toBase58()} B=${w.tokenMintB.toBase58()}`,
      );
    }
    return {
      kind: "whirlpool",
      dex: "orca-whirlpool",
      poolAddress: address.toBase58(),
      pair: this.cfg.pair,
      fetchedAtMs: Date.now(),
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
