import { describe, expect, it } from "vitest";
import { defaultScenario, SyntheticPriceSource } from "../src/datasource/synthetic.js";
import type { SnapshotPair } from "../src/datasource/PriceSource.js";
import { detect } from "../src/detect.js";

const params = {
  tradeSizeQuote: 10_000_000n, // 10 USDC
  minProfitThresholdQuote: 10_000n, // 0.01 USDC
  slippageToleranceBps: 50,
  estTxFeeQuote: 1_000n,
};

describe("SyntheticPriceSource", () => {
  it("emits every scenario pair, all snapshots labeled synthetic", async () => {
    const seen: SnapshotPair[] = [];
    const src = new SyntheticPriceSource(defaultScenario(), 0);
    await src.run((pair) => {
      seen.push(pair);
    });
    expect(seen.length).toBe(4);
    for (const { cpmm, whirlpool } of seen) {
      expect(cpmm.source).toBe("synthetic");
      expect(whirlpool.source).toBe("synthetic");
    }
  });

  it("stop() halts emission", async () => {
    const seen: SnapshotPair[] = [];
    const src = new SyntheticPriceSource(defaultScenario(), 0);
    await src.run((pair) => {
      seen.push(pair);
      if (seen.length === 2) src.stop();
    });
    expect(seen.length).toBe(2);
  });

  it("the engineered gap cycle is detected as an opportunity; balanced cycles are not", () => {
    const scenario = defaultScenario();
    const decisions = scenario.map((pair) =>
      detect(pair.cpmm, pair.whirlpool, params),
    );
    expect(decisions.map((d) => d.decision)).toEqual([
      "no-opportunity",
      "no-opportunity",
      "opportunity",
      "no-opportunity",
    ]);
    const opp = decisions[2]!;
    if (opp.decision !== "opportunity") throw new Error("unreachable");
    // SOL is cheap on the stale CPMM: buy there, sell on the whirlpool
    expect(opp.direction).toEqual({
      buyOn: "raydium-cpmm",
      sellOn: "orca-whirlpool",
    });
    expect(opp.estNetProfit > 0n).toBe(true);
  });
});
