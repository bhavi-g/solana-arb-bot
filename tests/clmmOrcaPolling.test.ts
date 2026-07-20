import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ClmmOrcaPollingSource,
  type AccountBatchFetcher,
} from "../src/datasource/clmmOrcaPolling.js";
import { RateLimiter } from "../src/datasource/rateLimiter.js";
import type { ClmmPoolState } from "../src/decode/clmm.js";
import type { WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";

const base = "So11111111111111111111111111111111111111112";
const quote = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const clmmAddr = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const orcaAddr = new PublicKey("FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q");
const pair = { baseMint: base, quoteMint: quote, baseDecimals: 9, quoteDecimals: 6 };

function clmm(mint0 = base, mint1 = quote): ClmmPoolState {
  return {
    ammConfig: new PublicKey(clmmAddr),
    tokenMint0: new PublicKey(mint0),
    tokenMint1: new PublicKey(mint1),
    tokenVault0: new PublicKey(clmmAddr),
    tokenVault1: new PublicKey(orcaAddr),
    observationKey: new PublicKey(clmmAddr),
    mintDecimals0: 9,
    mintDecimals1: 6,
    tickSpacing: 4,
    liquidity: 10n ** 15n,
    sqrtPriceX64: 7n,
    tickCurrentIndex: -25_696,
  };
}

function whirl(mintA = base, mintB = quote): WhirlpoolState {
  return {
    sqrtPriceX64: 9n,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    tickSpacing: 64,
    feeBps: 30,
    tokenMintA: new PublicKey(mintA),
    tokenMintB: new PublicKey(mintB),
    tokenVaultA: new PublicKey(clmmAddr),
    tokenVaultB: new PublicKey(orcaAddr),
  };
}

class FakeFetcher implements AccountBatchFetcher {
  calls = 0;
  constructor(
    private readonly slot: number,
    private readonly value: Array<{ data: Uint8Array } | null>,
    private readonly onCall?: () => void,
  ) {}
  async getMultipleAccountsInfoAndContext(_keys: PublicKey[]) {
    this.calls++;
    this.onCall?.();
    return { context: { slot: this.slot }, value: this.value };
  }
}

// Injected decoders: byte 0 → CLMM state, byte 1 → whirlpool state.
const decodeClmm = (_d: Uint8Array): ClmmPoolState => clmm();
const decodeWhirl = (_d: Uint8Array): WhirlpoolState => whirl();

function make(
  fetcher: AccountBatchFetcher,
  clmmFeeBps = 4,
  dc = decodeClmm,
  dw = decodeWhirl,
) {
  return new ClmmOrcaPollingSource(
    fetcher,
    { clmmPoolAddress: clmmAddr.toBase58(), whirlpoolAddress: orcaAddr.toBase58(), pair, pollIntervalMs: 0, clmmFeeBps },
    new RateLimiter(10),
    dc,
    dw,
  );
}

describe("ClmmOrcaPollingSource", () => {
  it("emits one SnapshotPair per cycle: CLMM in cpmm slot (injected feeBps), Orca in whirlpool slot", async () => {
    const fetcher = new FakeFetcher(555, [{ data: new Uint8Array([0]) }, { data: new Uint8Array([1]) }]);
    const source = make(fetcher, 4);
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
      source.stop();
    });
    expect(pairs.length).toBe(1);
    const p = pairs[0]!;
    expect(p.cpmm.kind).toBe("whirlpool");
    expect(p.cpmm.dex).toBe("raydium-clmm");
    expect(p.cpmm.poolAddress).toBe(clmmAddr.toBase58());
    expect(p.cpmm.feeBps).toBe(4);
    expect(p.whirlpool.kind).toBe("whirlpool");
    expect(p.whirlpool.dex).toBe("orca-whirlpool");
    expect(p.whirlpool.poolAddress).toBe(orcaAddr.toBase58());
    expect(p.cpmm.slot).toBe(555);
    if (p.cpmm.kind === "whirlpool") expect(p.cpmm.sqrtPriceX64).toBe(7n);
    if (p.whirlpool.kind === "whirlpool") expect(p.whirlpool.sqrtPriceX64).toBe(9n);
  });

  it("does not emit a pair when an account is missing (throws, caught by the loop)", async () => {
    let source!: ClmmOrcaPollingSource;
    const fetcher = new FakeFetcher(1, [null, { data: new Uint8Array([1]) }], () => source.stop());
    source = make(fetcher);
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
    });
    expect(fetcher.calls).toBe(1);
    expect(pairs.length).toBe(0);
  });

  it("rejects a CLMM pool whose orientation is not base=mint0 / quote=mint1", async () => {
    let source!: ClmmOrcaPollingSource;
    const fetcher = new FakeFetcher(1, [{ data: new Uint8Array([0]) }, { data: new Uint8Array([1]) }], () => source.stop());
    source = make(fetcher, 4, (_d) => clmm(quote, base)); // mint0=quote, mint1=base → bad
    const pairs: SnapshotPair[] = [];
    await source.run(async (p) => {
      pairs.push(p);
    });
    expect(fetcher.calls).toBe(1);
    expect(pairs.length).toBe(0);
  });
});
