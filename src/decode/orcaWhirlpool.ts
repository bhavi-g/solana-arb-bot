/**
 * Orca Whirlpool account decoding.
 *
 * Field order verified 2026-07-16 against
 * orca-so/whirlpools/programs/whirlpool/src/state/whirlpool.rs (main).
 * Anchor account: 8-byte discriminator, then borsh fields.
 * fee_rate is stored in hundredths of a basis point (1e6 denominator).
 */
import { PublicKey } from "@solana/web3.js";
import { readI32, readU16, readU128 } from "./layout.js";

// offsets after the 8-byte discriminator:
// whirlpools_config Pubkey @8, whirlpool_bump [u8;1] @40, tick_spacing u16 @41,
// fee_tier_index_seed [u8;2] @43
const TICK_SPACING = 41; // u16
const FEE_RATE = 45; // u16 (fee_tier_index_seed [u8;2] @43)
const LIQUIDITY = 49; // u128 (protocol_fee_rate u16 @47)
const SQRT_PRICE = 65; // u128
const TICK_CURRENT_INDEX = 81; // i32
// protocol_fee_owed_a u64 @85, protocol_fee_owed_b u64 @93
const TOKEN_MINT_A = 101;
const TOKEN_VAULT_A = 133;
// fee_growth_global_a u128 @165
const TOKEN_MINT_B = 181;
const TOKEN_VAULT_B = 213;

export const WHIRLPOOL_MIN_LEN = TOKEN_VAULT_B + 32;

export interface WhirlpoolState {
  sqrtPriceX64: bigint;
  liquidity: bigint;
  tickCurrentIndex: number;
  tickSpacing: number;
  /** Trade fee in basis points. */
  feeBps: number;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
}

export function decodeWhirlpool(data: Uint8Array): WhirlpoolState {
  if (data.length < WHIRLPOOL_MIN_LEN) {
    throw new Error(`Whirlpool too short: ${data.length} < ${WHIRLPOOL_MIN_LEN}`);
  }
  return {
    sqrtPriceX64: readU128(data, SQRT_PRICE),
    liquidity: readU128(data, LIQUIDITY),
    tickCurrentIndex: readI32(data, TICK_CURRENT_INDEX),
    tickSpacing: readU16(data, TICK_SPACING),
    feeBps: readU16(data, FEE_RATE) / 100,
    tokenMintA: new PublicKey(data.slice(TOKEN_MINT_A, TOKEN_MINT_A + 32)),
    tokenMintB: new PublicKey(data.slice(TOKEN_MINT_B, TOKEN_MINT_B + 32)),
    tokenVaultA: new PublicKey(data.slice(TOKEN_VAULT_A, TOKEN_VAULT_A + 32)),
    tokenVaultB: new PublicKey(data.slice(TOKEN_VAULT_B, TOKEN_VAULT_B + 32)),
  };
}
