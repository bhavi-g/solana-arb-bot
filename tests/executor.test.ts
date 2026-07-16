import { describe, expect, it, vi } from "vitest";
import { execute, type ExecutorRpc } from "../src/executor.js";
import { AttemptLogger } from "../src/logger.js";
import type { Opportunity } from "../src/types.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opp: Opportunity = {
  decision: "opportunity",
  direction: { buyOn: "raydium-cpmm", sellOn: "orca-whirlpool" },
  gapBps: -300,
  quoteIn: 10_000_000n,
  baseOut: 68_000_000n,
  quoteOut: 10_250_000n,
  estNetProfit: 250_000n,
  minProfitThreshold: 10_000n,
};

const meta = { cluster: "devnet", dataSource: "synthetic", slot: 3 };

/** Fake transaction: records the compute-unit limit it was built with. */
function fakeBuildTx() {
  const builds: (number | undefined)[] = [];
  return {
    builds,
    buildTx: (cuLimit?: number) => {
      builds.push(cuLimit);
      return { serialize: () => new Uint8Array([1, 2, 3, cuLimit ?? 0]) };
    },
  };
}

function makeRpc(overrides: Partial<{
  err: unknown;
  unitsConsumed: number;
  sendResult: Promise<string>;
}> = {}): { rpc: ExecutorRpc; simulateSpy: ReturnType<typeof vi.fn>; sendSpy: ReturnType<typeof vi.fn> } {
  const simulateSpy = vi.fn(async () => ({
    context: { slot: 42 },
    value: {
      err: overrides.err ?? null,
      logs: ["Program log: ok"],
      unitsConsumed: overrides.unitsConsumed ?? 87_500,
    },
  }));
  const sendSpy = vi.fn(
    () => overrides.sendResult ?? Promise.resolve("Sig1111"),
  );
  return {
    rpc: { simulateTransaction: simulateSpy, sendRawTransaction: sendSpy },
    simulateSpy,
    sendSpy,
  };
}

function tempLogger() {
  const dir = mkdtempSync(join(tmpdir(), "arb-exec-"));
  const file = join(dir, "attempts.jsonl");
  return { logger: new AttemptLogger(file), file };
}

describe("execute (the ADR-0005 simulate-then-send gate)", () => {
  it("ABORTS when simulation returns an error and NEVER calls send", async () => {
    const { rpc, sendSpy, simulateSpy } = makeRpc({
      err: { InstructionError: [1, { Custom: 6001 }] },
    });
    const { buildTx } = fakeBuildTx();
    const { logger, file } = tempLogger();

    const result = await execute(rpc, buildTx, opp, logger, meta);

    expect(simulateSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(result.action).toBe("aborted-simulation-failed");

    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.action).toBe("aborted-simulation-failed");
    expect(line.simulation.err).toEqual({ InstructionError: [1, { Custom: 6001 }] });
    expect(line.reason).toMatch(/simulation/i);
  });

  it("ABORTS when the opportunity's net profit is below threshold (defense in depth)", async () => {
    const { rpc, sendSpy } = makeRpc();
    const { buildTx } = fakeBuildTx();
    const { logger } = tempLogger();
    const marginal: Opportunity = {
      ...opp,
      estNetProfit: 9_999n,
      minProfitThreshold: 10_000n,
    };

    const result = await execute(rpc, buildTx, marginal, logger, meta);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result.action).toBe("aborted-below-threshold");
  });

  it("sends exactly once when simulation passes, with CU budget measured from simulation", async () => {
    const { rpc, sendSpy } = makeRpc({ unitsConsumed: 100_000 });
    const { buildTx, builds } = fakeBuildTx();
    const { logger, file } = tempLogger();

    const result = await execute(rpc, buildTx, opp, logger, meta);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("sent");
    expect(result.signature).toBe("Sig1111");
    // first build: no explicit limit (for simulation); second: measured + margin
    expect(builds.length).toBe(2);
    expect(builds[0]).toBeUndefined();
    expect(builds[1]).toBeGreaterThanOrEqual(100_000);
    expect(builds[1]).toBeLessThanOrEqual(130_000);

    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.action).toBe("sent");
    expect(line.simulation.unitsConsumed).toBe(100_000);
  });

  it("logs send-failed (not sent) when the RPC send throws", async () => {
    const { rpc, sendSpy } = makeRpc({
      sendResult: Promise.reject(new Error("blockhash expired")),
    });
    const { buildTx } = fakeBuildTx();
    const { logger, file } = tempLogger();

    const result = await execute(rpc, buildTx, opp, logger, meta);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("send-failed");
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.action).toBe("send-failed");
    expect(line.reason).toMatch(/blockhash expired/);
  });

  it("every outcome writes an attempt record (no silent paths)", async () => {
    const { logger, file } = tempLogger();
    const { buildTx } = fakeBuildTx();

    await execute(makeRpc({ err: "AccountNotFound" }).rpc, buildTx, opp, logger, meta);
    await execute(
      makeRpc().rpc,
      buildTx,
      { ...opp, estNetProfit: 0n },
      logger,
      meta,
    );
    await execute(makeRpc().rpc, buildTx, opp, logger, meta);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines.map((l) => JSON.parse(l).action)).toEqual([
      "aborted-simulation-failed",
      "aborted-below-threshold",
      "sent",
    ]);
  });
});
