/**
 * Raydium CLMM (concentrated liquidity) account decoding.
 *
 * Field order verified against raydium-io/raydium-clmm
 * programs/amm/src/states/{pool,config}.rs @ 03b44b7 (master, 2026-07-16)
 * AND against live mainnet account data
 * (scripts/probe-mainnet-clmm-pools.ts, pool
 * 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv). Both checks are required
 * — do not trust one alone.
 *
 * PoolState is a zero-copy #[repr(C, packed)] account: 8-byte Anchor
 * discriminator, then C-packed fields with no alignment padding, so every
 * offset below is fixed byte arithmetic.
 *
 * WARNING: the fee is NOT in this account. It lives in the referenced
 * AmmConfig (decodeClmmAmmConfigFeeBps), an Anchor Borsh #[account] (also
 * unpadded). CLMM's AmmConfig layout differs from Raydium CPMM's AmmConfig
 * — do NOT reuse raydiumCpmm's decoder.
 */
import { PublicKey } from "@solana/web3.js";
import { readI32, readU16, readU128, readU32 } from "./layout.js";
import type { PairInfo, WhirlpoolSnapshot } from "../types.js";

// offsets after the 8-byte discriminator (repr(packed) PoolState):
// bump [u8;1] @8, owner Pubkey @41 (skipped)
const AMM_CONFIG = 9;
const TOKEN_MINT_0 = 73;
const TOKEN_MINT_1 = 105;
const TOKEN_VAULT_0 = 137;
const TOKEN_VAULT_1 = 169;
const OBSERVATION_KEY = 201;
const MINT_DECIMALS_0 = 233;
const MINT_DECIMALS_1 = 234;
const TICK_SPACING = 235; // u16
const LIQUIDITY = 237; // u128
const SQRT_PRICE_X64 = 253; // u128
const TICK_CURRENT = 269; // i32

export const CLMM_POOL_STATE_MIN_LEN = TICK_CURRENT + 4;

export interface ClmmPoolState {
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  observationKey: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrentIndex: number;
}

export function decodeClmmPool(data: Uint8Array): ClmmPoolState {
  if (data.length < CLMM_POOL_STATE_MIN_LEN) {
    throw new Error(
      `ClmmPoolState too short: ${data.length} < ${CLMM_POOL_STATE_MIN_LEN}`,
    );
  }
  return {
    ammConfig: new PublicKey(data.slice(AMM_CONFIG, AMM_CONFIG + 32)),
    tokenMint0: new PublicKey(data.slice(TOKEN_MINT_0, TOKEN_MINT_0 + 32)),
    tokenMint1: new PublicKey(data.slice(TOKEN_MINT_1, TOKEN_MINT_1 + 32)),
    tokenVault0: new PublicKey(data.slice(TOKEN_VAULT_0, TOKEN_VAULT_0 + 32)),
    tokenVault1: new PublicKey(data.slice(TOKEN_VAULT_1, TOKEN_VAULT_1 + 32)),
    observationKey: new PublicKey(
      data.slice(OBSERVATION_KEY, OBSERVATION_KEY + 32),
    ),
    mintDecimals0: data[MINT_DECIMALS_0]!,
    mintDecimals1: data[MINT_DECIMALS_1]!,
    tickSpacing: readU16(data, TICK_SPACING),
    liquidity: readU128(data, LIQUIDITY),
    sqrtPriceX64: readU128(data, SQRT_PRICE_X64),
    tickCurrentIndex: readI32(data, TICK_CURRENT),
  };
}

// AmmConfig (Anchor Borsh #[account], unpadded): bump u8 @8, index u16 @9,
// owner @11, protocol_fee_rate u32 @43, trade_fee_rate u32 @47 (ppm, denom 1e6).
const TRADE_FEE_RATE = 47;

export const CLMM_AMM_CONFIG_MIN_LEN = TRADE_FEE_RATE + 4;

/** CLMM trade fee in basis points (on-chain rate is parts-per-million). */
export function decodeClmmAmmConfigFeeBps(data: Uint8Array): number {
  if (data.length < CLMM_AMM_CONFIG_MIN_LEN) {
    throw new Error(`ClmmAmmConfig too short: ${data.length}`);
  }
  return readU32(data, TRADE_FEE_RATE) / 100;
}

export interface ClmmSnapshotMeta {
  poolAddress: string;
  pair: PairInfo;
  slot: number;
  source: string;
  fetchStartedAtMs: number;
}

/**
 * Adapt a decoded CLMM pool into the shared WhirlpoolSnapshot (kind
 * "whirlpool", dex "raydium-clmm"), so detect.ts consumes it with no
 * changes. Asserts base=mint0 / quote=mint1 orientation; an inverted pool
 * throws rather than being silently transformed (see the design spec).
 */
export function toClmmSnapshot(
  state: ClmmPoolState,
  feeBps: number,
  meta: ClmmSnapshotMeta,
): WhirlpoolSnapshot {
  if (
    state.tokenMint0.toBase58() !== meta.pair.baseMint ||
    state.tokenMint1.toBase58() !== meta.pair.quoteMint
  ) {
    throw new Error(
      `CLMM pool ${meta.poolAddress} orientation mismatch: expected ` +
        `mint0=${meta.pair.baseMint} mint1=${meta.pair.quoteMint}, got ` +
        `mint0=${state.tokenMint0.toBase58()} mint1=${state.tokenMint1.toBase58()}`,
    );
  }
  return {
    kind: "whirlpool",
    dex: "raydium-clmm",
    poolAddress: meta.poolAddress,
    pair: meta.pair,
    fetchStartedAtMs: meta.fetchStartedAtMs,
    slot: meta.slot,
    source: meta.source,
    sqrtPriceX64: state.sqrtPriceX64,
    liquidity: state.liquidity,
    tickCurrentIndex: state.tickCurrentIndex,
    feeBps,
  };
}
