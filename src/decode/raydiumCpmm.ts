/**
 * Raydium CP-Swap (CPMM) account decoding.
 *
 * Field order verified 2026-07-16 against
 * raydium-io/raydium-cp-swap/programs/cp-swap/src/states/pool.rs and
 * config.rs (master). Anchor accounts: 8-byte discriminator, then borsh
 * fields, no padding between them.
 *
 * Pool reserves are NOT stored in PoolState — they are the two vault
 * token-account balances minus accrued protocol/fund/creator fees
 * (pool.rs vault_amount_without_fee).
 */
import { PublicKey } from "@solana/web3.js";
import { readU64 } from "./layout.js";

// PoolState offsets (after 8-byte discriminator; 10 pubkeys back-to-back)
const AMM_CONFIG = 8;
const TOKEN_0_VAULT = 72;
const TOKEN_1_VAULT = 104;
const TOKEN_0_MINT = 168;
const TOKEN_1_MINT = 200;
const MINT_0_DECIMALS = 331;
const MINT_1_DECIMALS = 332;
const PROTOCOL_FEES_TOKEN_0 = 341;
const PROTOCOL_FEES_TOKEN_1 = 349;
const FUND_FEES_TOKEN_0 = 357;
const FUND_FEES_TOKEN_1 = 365;
// open_time u64 @373, recent_epoch u64 @381, creator_fee_on u8 @389,
// enable_creator_fee bool @390, padding1 [u8;6] @391
const CREATOR_FEES_TOKEN_0 = 397;
const CREATOR_FEES_TOKEN_1 = 405;

export const RAYDIUM_POOL_STATE_MIN_LEN = CREATOR_FEES_TOKEN_1 + 8;

export interface RaydiumCpmmPoolState {
  ammConfig: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  mint0Decimals: number;
  mint1Decimals: number;
  /** Fees accrued inside the vaults, to subtract from vault balances. */
  feesToken0: bigint;
  feesToken1: bigint;
}

export function decodeRaydiumCpmmPool(data: Uint8Array): RaydiumCpmmPoolState {
  if (data.length < RAYDIUM_POOL_STATE_MIN_LEN) {
    throw new Error(
      `PoolState too short: ${data.length} < ${RAYDIUM_POOL_STATE_MIN_LEN}`,
    );
  }
  return {
    ammConfig: new PublicKey(data.slice(AMM_CONFIG, AMM_CONFIG + 32)),
    token0Vault: new PublicKey(data.slice(TOKEN_0_VAULT, TOKEN_0_VAULT + 32)),
    token1Vault: new PublicKey(data.slice(TOKEN_1_VAULT, TOKEN_1_VAULT + 32)),
    token0Mint: new PublicKey(data.slice(TOKEN_0_MINT, TOKEN_0_MINT + 32)),
    token1Mint: new PublicKey(data.slice(TOKEN_1_MINT, TOKEN_1_MINT + 32)),
    mint0Decimals: data[MINT_0_DECIMALS]!,
    mint1Decimals: data[MINT_1_DECIMALS]!,
    feesToken0:
      readU64(data, PROTOCOL_FEES_TOKEN_0) +
      readU64(data, FUND_FEES_TOKEN_0) +
      readU64(data, CREATOR_FEES_TOKEN_0),
    feesToken1:
      readU64(data, PROTOCOL_FEES_TOKEN_1) +
      readU64(data, FUND_FEES_TOKEN_1) +
      readU64(data, CREATOR_FEES_TOKEN_1),
  };
}

// AmmConfig: bump u8 @8, disable_create_pool bool @9, index u16 @10,
// trade_fee_rate u64 @12 (denominator 10^6)
const TRADE_FEE_RATE = 12;

/** Trade fee in basis points (on-chain rate is parts-per-million). */
export function decodeAmmConfigFeeBps(data: Uint8Array): number {
  if (data.length < TRADE_FEE_RATE + 8) {
    throw new Error(`AmmConfig too short: ${data.length}`);
  }
  return Number(readU64(data, TRADE_FEE_RATE)) / 100;
}

/** SPL token account: mint(32) owner(32) amount u64 @64. */
export function decodeTokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) {
    throw new Error(`token account too short: ${data.length}`);
  }
  return readU64(data, 64);
}
