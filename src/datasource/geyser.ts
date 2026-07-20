/**
 * Yellowstone Geyser gRPC price source (ADR-0006 drop-in; Phase 2
 * deliverable per the updated phase doc — built now, RUN ONLY once the
 * owner provides an endpoint; Geyser is not on the Helius free tier and
 * procurement is a stop-and-ask money item).
 *
 * The gRPC client is isolated behind GeyserTransport so this class is
 * pure and unit-testable; createYellowstoneTransport below is the only
 * part that touches the wire, and it is constructed only when
 * GEYSER_ENDPOINT is configured.
 *
 * KNOWN GAP (documented, deliberate): CPMM reserves live in the pool's
 * vault token accounts, not the pool account itself, so a runnable Geyser
 * build must also subscribe both vaults and decode token-account amounts.
 * That wiring needs a live endpoint to verify honestly, so it is left
 * unwired — the injected decodeCpmm for the real transport throws with
 * this explanation (see main.ts). The GeyserPriceSource pair-assembly
 * logic itself is complete and tested.
 */
// CJS package under NodeNext ESM interop: the default import binds to
// module.exports, so the Client class lives at `.default`.
import yellowstone from "@triton-one/yellowstone-grpc";
const { default: Client, CommitmentLevel } = yellowstone;
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";

export interface GeyserAccountUpdate {
  pubkey: string;
  data: Uint8Array;
  slot: number;
  /** Wall-clock ms when the update reached us (drives handoffMs). */
  receivedAtMs: number;
}

export interface GeyserTransport {
  /** Resolves when the stream ends (after close()). */
  subscribe(
    accounts: string[],
    onUpdate: (u: GeyserAccountUpdate) => void,
  ): Promise<void>;
  close(): void;
}

export interface GeyserSourceOptions {
  raydiumPoolAddress: string;
  orcaPoolAddress: string;
  pair: PairInfo;
  decodeCpmm: (data: Uint8Array) => {
    baseReserve: bigint;
    quoteReserve: bigint;
    feeBps: number;
  };
  decodeWhirl: (data: Uint8Array) => {
    sqrtPriceX64: bigint;
    liquidity: bigint;
    tickCurrentIndex: number;
    feeBps: number;
  };
}

export class GeyserPriceSource implements PriceSource {
  readonly name = "geyser";
  private latestCpmm: PoolSnapshot | null = null;
  private latestWhirl: PoolSnapshot | null = null;

  constructor(
    private readonly transport: GeyserTransport,
    private readonly opts: GeyserSourceOptions,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    await this.transport.subscribe(
      [this.opts.raydiumPoolAddress, this.opts.orcaPoolAddress],
      (u) => {
        this.apply(u);
        if (this.latestCpmm && this.latestWhirl) {
          void onPair({
            cpmm: this.latestCpmm,
            whirlpool: this.latestWhirl,
          } satisfies SnapshotPair);
        }
      },
    );
  }

  stop(): void {
    this.transport.close();
  }

  private apply(u: GeyserAccountUpdate): void {
    const base = {
      pair: this.opts.pair,
      fetchStartedAtMs: u.receivedAtMs,
      slot: u.slot,
      source: this.name,
    };
    if (u.pubkey === this.opts.raydiumPoolAddress) {
      this.latestCpmm = {
        kind: "cpmm",
        dex: "raydium-cpmm",
        poolAddress: u.pubkey,
        ...base,
        ...this.opts.decodeCpmm(u.data),
      };
    } else if (u.pubkey === this.opts.orcaPoolAddress) {
      this.latestWhirl = {
        kind: "whirlpool",
        dex: "orca-whirlpool",
        poolAddress: u.pubkey,
        ...base,
        ...this.opts.decodeWhirl(u.data),
      };
    }
  }
}

/**
 * Real Yellowstone wiring (@triton-one/yellowstone-grpc 5.0.9: Client is
 * the default export; subscribe(request) returns a Duplex emitting
 * SubscribeUpdate messages). Constructed only when GEYSER_ENDPOINT is set.
 */
export async function createYellowstoneTransport(
  endpoint: string,
  xToken: string | undefined,
): Promise<GeyserTransport> {
  const client = new Client(endpoint, xToken, undefined);
  let stream: Awaited<ReturnType<typeof client.subscribe>> | null = null;
  return {
    async subscribe(accounts, onUpdate) {
      stream = await client.subscribe({
        accounts: {
          pools: {
            account: accounts,
            owner: [],
            filters: [],
            nonemptyTxnSignature: false,
          },
        },
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.PROCESSED,
      });
      await new Promise<void>((resolve, reject) => {
        stream!.on(
          "data",
          (msg: {
            account?: {
              account?: { pubkey: Uint8Array; data: Uint8Array };
              slot?: string;
            };
          }) => {
            const acc = msg.account?.account;
            if (!acc) return;
            onUpdate({
              pubkey: bs58encode(acc.pubkey),
              data: acc.data,
              slot: Number(msg.account?.slot ?? 0),
              receivedAtMs: Date.now(),
            });
          },
        );
        stream!.on("error", reject);
        stream!.on("end", resolve);
        stream!.on("close", resolve);
      });
    },
    close() {
      stream?.destroy();
    },
  };
}

// Local, dependency-free base58 (pubkeys arrive as raw bytes on the stream).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
