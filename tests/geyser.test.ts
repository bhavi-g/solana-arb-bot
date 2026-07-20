import { describe, expect, it } from "vitest";
import {
  GeyserPriceSource,
  type GeyserAccountUpdate,
  type GeyserTransport,
} from "../src/datasource/geyser.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";

const pair = { baseMint: "SOL", quoteMint: "USDC", baseDecimals: 9, quoteDecimals: 6 };

/** Decoders are injected, so tests need no real account bytes. */
const decodeCpmm = (_: Uint8Array) => ({
  baseReserve: 10n,
  quoteReserve: 1500n,
  feeBps: 25,
});
const decodeWhirl = (_: Uint8Array) => ({
  sqrtPriceX64: 7n,
  liquidity: 5n,
  tickCurrentIndex: -1,
  feeBps: 30,
});

class FakeTransport implements GeyserTransport {
  handler: ((u: GeyserAccountUpdate) => void) | null = null;
  closed = false;
  private resolveDone!: () => void;
  done = new Promise<void>((r) => (this.resolveDone = r));
  async subscribe(
    _accounts: string[],
    onUpdate: (u: GeyserAccountUpdate) => void,
  ): Promise<void> {
    this.handler = onUpdate;
    return this.done;
  }
  close(): void {
    this.closed = true;
    this.resolveDone();
  }
  push(u: GeyserAccountUpdate): void {
    this.handler!(u);
  }
}

const upd = (pubkey: string, slot: number): GeyserAccountUpdate => ({
  pubkey,
  data: new Uint8Array([1]),
  slot,
  receivedAtMs: 1000 + slot,
});

function makeSource(t: FakeTransport): GeyserPriceSource {
  return new GeyserPriceSource(t, {
    raydiumPoolAddress: "RAY",
    orcaPoolAddress: "ORCA",
    pair,
    decodeCpmm,
    decodeWhirl,
  });
}

describe("GeyserPriceSource", () => {
  it("emits a pair only once BOTH pools have been seen, then on every update", async () => {
    const t = new FakeTransport();
    const source = makeSource(t);
    const pairs: SnapshotPair[] = [];
    const run = source.run(async (p) => {
      pairs.push(p);
    });

    t.push(upd("RAY", 100));
    expect(pairs.length).toBe(0); // whirlpool not seen yet
    t.push(upd("ORCA", 101));
    expect(pairs.length).toBe(1);
    t.push(upd("RAY", 102));
    expect(pairs.length).toBe(2);
    expect(pairs[1]!.cpmm.slot).toBe(102);
    expect(pairs[1]!.whirlpool.slot).toBe(101); // freshest known state
    expect(pairs[0]!.cpmm.source).toBe("geyser");
    expect(pairs[0]!.cpmm.fetchStartedAtMs).toBe(1100); // transport receive time
    expect(pairs[0]!.cpmm.kind).toBe("cpmm");
    expect(pairs[0]!.whirlpool.kind).toBe("whirlpool");

    source.stop();
    await run;
    expect(t.closed).toBe(true);
  });

  it("ignores updates for unknown accounts", async () => {
    const t = new FakeTransport();
    const source = makeSource(t);
    const pairs: SnapshotPair[] = [];
    const run = source.run(async (p) => {
      pairs.push(p);
    });
    t.push(upd("RAY", 1));
    t.push(upd("SOMETHING_ELSE", 2));
    expect(pairs.length).toBe(0);
    source.stop();
    await run;
  });
});
