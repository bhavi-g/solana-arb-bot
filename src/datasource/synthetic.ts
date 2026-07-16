/**
 * SyntheticPriceSource: emits a scripted sequence of snapshot pairs so the
 * whole pipeline (detect -> build -> simulate -> log) can be exercised
 * deterministically, including exactly one engineered arbitrage gap.
 *
 * NEVER_DO compliance: these are synthetic INPUTS, clearly labeled
 * source="synthetic" on every snapshot and in every log line downstream.
 * Simulation results are always real RPC output — never fabricated here
 * or anywhere else.
 */
import type { PairInfo, PoolSnapshot } from "../types.js";
import type { PriceSource, SnapshotHandler, SnapshotPair } from "./PriceSource.js";

export const SOL_USDC_DEVNET: PairInfo = {
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC
  baseDecimals: 9,
  quoteDecimals: 6,
};

const Q64 = 2n ** 64n;

/**
 * sqrtPriceX64 for a human price of ~150 USDC/SOL:
 * raw price = 150e6/1e9 = 0.15; sqrt(0.15) ~= 0.387298; * 2^64.
 */
const SQRT_PRICE_150 = 7_144_247_248_808_263_680n;

function cpmm(
  baseReserve: bigint,
  quoteReserve: bigint,
  slot: number,
): PoolSnapshot {
  return {
    kind: "cpmm",
    dex: "raydium-cpmm",
    poolAddress: "SyntheticRaydiumCpmmPool11111111111111111111",
    pair: SOL_USDC_DEVNET,
    fetchedAtMs: Date.now(),
    slot,
    source: "synthetic",
    baseReserve,
    quoteReserve,
    feeBps: 25,
  };
}

function whirl(sqrtPriceX64: bigint, slot: number): PoolSnapshot {
  return {
    kind: "whirlpool",
    dex: "orca-whirlpool",
    poolAddress: "SyntheticOrcaWhirlpool1111111111111111111111",
    pair: SOL_USDC_DEVNET,
    fetchedAtMs: Date.now(),
    slot,
    source: "synthetic",
    sqrtPriceX64,
    liquidity: 10n ** 15n,
    tickCurrentIndex: -18_975,
    feeBps: 30,
  };
}

/**
 * Scenario: two balanced cycles (~150 USDC/SOL on both venues), then one
 * cycle where the Raydium pool's quote reserve is ~3% low (stale after a
 * move — SOL cheap there), then balance restored.
 */
export function defaultScenario(): SnapshotPair[] {
  // 10,000 SOL / 1,500,000 USDC -> price 150
  const balanced = () => cpmm(10_000n * 10n ** 9n, 1_500_000n * 10n ** 6n, 1);
  return [
    { cpmm: balanced(), whirlpool: whirl(SQRT_PRICE_150, 1) },
    { cpmm: balanced(), whirlpool: whirl(SQRT_PRICE_150, 2) },
    {
      // SOL ~3% cheaper on the CPMM: quote reserve down to 1,455,000
      cpmm: cpmm(10_000n * 10n ** 9n, 1_455_000n * 10n ** 6n, 3),
      whirlpool: whirl(SQRT_PRICE_150, 3),
    },
    { cpmm: balanced(), whirlpool: whirl(SQRT_PRICE_150, 4) },
  ];
}

export class SyntheticPriceSource implements PriceSource {
  readonly name = "synthetic";
  private stopped = false;

  constructor(
    private readonly scenario: SnapshotPair[] = defaultScenario(),
    private readonly delayMs = 250,
  ) {}

  async run(onPair: SnapshotHandler): Promise<void> {
    for (const pair of this.scenario) {
      if (this.stopped) break;
      await onPair(pair);
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
