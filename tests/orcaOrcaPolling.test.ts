import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  OrcaOrcaPollingSource,
  type AccountBatchFetcher,
} from "../src/datasource/orcaOrcaPolling.js";
import { RateLimiter } from "../src/datasource/rateLimiter.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";

const base = "So11111111111111111111111111111111111111112";
const quote = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const addrA = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
const addrB = new PublicKey("FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q");
const pair = { baseMint: base, quoteMint: quote, baseDecimals: 9, quoteDecimals: 6 };

function whirl(sqrt: bigint, mintA = base, mintB = quote): WhirlpoolState {
  return {
    sqrtPriceX64: sqrt,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    tickSpacing: 4,
    feeBps: 4,
    tokenMintA: new PublicKey(mintA),
    tokenMintB: new PublicKey(mintB),
    tokenVaultA: addrA,
    tokenVaultB: addrB,
  };
}

class FakeFetcher implements AccountBatchFetcher {
  calls = 0;
  constructor(
    private readonly slot: number,
    private readonly onCall?: () => void,
  ) {}
  async getMultipleAccountsInfoAndContext(_keys: PublicKey[]) {
    this.calls++;
    this.onCall?.();
    return {
      context: { slot: this.slot },
      value: [{ data: new Uint8Array([0]) }, { data: new Uint8Array([1]) }],
    };
  }
}

// Injected decoder: byte 0 → pool A state, byte 1 → pool B state.
const decode = (data: Uint8Array): WhirlpoolState =>
  data[0] === 0 ? whirl(7n) : whirl(9n);

function make(fetcher: FakeFetcher, decodeFn = decode) {
  return new OrcaOrcaPollingSource(
    fetcher,
    { whirlpoolAAddress: addrA.toBase58(), whirlpoolBAddress: addrB.toBase58(), pair, pollIntervalMs: 0 },
    new RateLimiter(10),
    decodeFn,
  );
}

describe("OrcaOrcaPollingSource", () => {
  it("emits one SnapshotPair per cycle with both whirlpool venues in slots", async () => {
    const source = make(new FakeFetcher(555));
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
      source.stop();
    });
    expect(pairs.length).toBe(1);
    const p = pairs[0]!;
    expect(p.cpmm.kind).toBe("whirlpool");
    expect(p.whirlpool.kind).toBe("whirlpool");
    expect(p.cpmm.poolAddress).toBe(addrA.toBase58());
    expect(p.whirlpool.poolAddress).toBe(addrB.toBase58());
    expect(p.cpmm.slot).toBe(555);
    if (p.cpmm.kind === "whirlpool") expect(p.cpmm.sqrtPriceX64).toBe(7n);
    if (p.whirlpool.kind === "whirlpool") expect(p.whirlpool.sqrtPriceX64).toBe(9n);
  });

  it("rejects a whirlpool whose orientation is not A=base B=quote (no pair emitted)", async () => {
    let source!: OrcaOrcaPollingSource;
    // Stop the loop after the first fetch so a caught orientation error
    // cannot spin forever.
    const fetcher = new FakeFetcher(1, () => source.stop());
    source = make(fetcher, () => whirl(7n, quote, base)); // A=quote, B=base → bad
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
    });
    expect(fetcher.calls).toBe(1);
    expect(pairs.length).toBe(0);
  });
});
