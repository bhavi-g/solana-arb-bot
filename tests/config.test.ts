import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** Minimal valid env for a devnet synthetic run. */
function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PHASE: "1",
    CLUSTER: "devnet",
    HELIUS_API_KEY: "test-key",
    KEYPAIR_PATH: "keypairs/devnet.json",
    DATA_SOURCE: "synthetic",
    TRADE_SIZE_QUOTE: "10000000",
    MIN_PROFIT_THRESHOLD_QUOTE: "10000",
    SLIPPAGE_TOLERANCE_BPS: "50",
    MAX_RPS: "8",
    POLL_INTERVAL_MS: "1000",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads a valid devnet config", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.cluster).toBe("devnet");
    expect(cfg.phase).toBe(1);
    expect(cfg.rpcUrl).toContain("devnet.helius-rpc.com");
    expect(cfg.tradeSizeQuote).toBe(10_000_000n);
    expect(cfg.minProfitThresholdQuote).toBe(10_000n);
    expect(cfg.commitment).toBe("processed");
  });

  it("NEVER_DO guard: refuses mainnet cluster while PHASE=1", () => {
    expect(() =>
      loadConfig(validEnv({ CLUSTER: "mainnet-beta" })),
    ).toThrow(/mainnet.*Phase 1|Phase 1.*mainnet/i);
  });

  it("NEVER_DO guard: refuses an explicit RPC_URL pointing at mainnet while PHASE=1", () => {
    expect(() =>
      loadConfig(
        validEnv({ RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }),
      ),
    ).toThrow(/mainnet.*Phase 1|Phase 1.*mainnet/i);
  });

  it("fails loudly listing every missing required key", () => {
    expect(() =>
      loadConfig({ PHASE: "1", CLUSTER: "devnet" }),
    ).toThrow(/KEYPAIR_PATH.*|MIN_PROFIT_THRESHOLD_QUOTE/);
    try {
      loadConfig({ PHASE: "1", CLUSTER: "devnet" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("KEYPAIR_PATH");
      expect(msg).toContain("TRADE_SIZE_QUOTE");
      expect(msg).toContain("MIN_PROFIT_THRESHOLD_QUOTE");
    }
  });

  it("requires an RPC source (HELIUS_API_KEY or RPC_URL)", () => {
    expect(() =>
      loadConfig(validEnv({ HELIUS_API_KEY: undefined })),
    ).toThrow(/HELIUS_API_KEY|RPC_URL/);
  });

  it("prefers explicit RPC_URL over derived Helius URL", () => {
    const cfg = loadConfig(
      validEnv({ RPC_URL: "https://api.devnet.solana.com" }),
    );
    expect(cfg.rpcUrl).toBe("https://api.devnet.solana.com");
  });

  it("requires pool addresses when DATA_SOURCE=polling", () => {
    expect(() => loadConfig(validEnv({ DATA_SOURCE: "polling" }))).toThrow(
      /RAYDIUM_POOL_ADDRESS|ORCA_POOL_ADDRESS/,
    );
  });

  it("rejects a min-profit threshold below zero (threshold can never be weakened to negative)", () => {
    expect(() =>
      loadConfig(validEnv({ MIN_PROFIT_THRESHOLD_QUOTE: "-1" })),
    ).toThrow(/MIN_PROFIT_THRESHOLD_QUOTE/);
  });

  it("caps MAX_RPS at the Helius free-tier ceiling of 10", () => {
    expect(() => loadConfig(validEnv({ MAX_RPS: "25" }))).toThrow(/10/);
  });
});
