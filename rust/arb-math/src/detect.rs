//! Opportunity detection, ported from `src/detect.ts` (ADR-0012): a pure
//! function over two pool snapshots that evaluates both trade directions
//! with fee-aware AMM math and flags an opportunity only when the better
//! direction's net profit clears the configured threshold.
//!
//! Uses `num_bigint::BigInt` throughout, not `u64`/`u128`: these are
//! off-chain estimation quantities that mirror the TS side's
//! arbitrary-precision `bigint` exactly. A Whirlpool's Q64.64 sqrt price
//! is itself stored on-chain as a u128, and squaring it for the gap
//! calculation needs up to 256 bits — unlike the on-chain-instruction
//! guard math in `lib.rs`, nothing here is bounded by an SPL instruction
//! field width, so there is no u64/u128 ceiling to mirror.

use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};
use std::fmt;

#[derive(Debug)]
pub struct PairMismatch {
    pub a: (String, String),
    pub b: (String, String),
}

impl fmt::Display for PairMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "snapshots are for different pairs: {}/{} vs {}/{}",
            self.a.0, self.a.1, self.b.0, self.b.1
        )
    }
}

impl std::error::Error for PairMismatch {}

#[derive(Debug, Clone)]
pub struct PairInfo {
    pub base_mint: String,
    pub quote_mint: String,
}

#[derive(Debug, Clone)]
pub enum PoolSnapshot {
    Cpmm {
        dex: String,
        pool_address: String,
        pair: PairInfo,
        base_reserve: BigInt,
        quote_reserve: BigInt,
        fee_bps: u16,
    },
    Whirlpool {
        dex: String,
        pool_address: String,
        pair: PairInfo,
        sqrt_price_x64: BigInt,
        fee_bps: u16,
    },
}

impl PoolSnapshot {
    fn pair(&self) -> &PairInfo {
        match self {
            PoolSnapshot::Cpmm { pair, .. } | PoolSnapshot::Whirlpool { pair, .. } => pair,
        }
    }
    fn dex(&self) -> &str {
        match self {
            PoolSnapshot::Cpmm { dex, .. } | PoolSnapshot::Whirlpool { dex, .. } => dex,
        }
    }
    fn pool_address(&self) -> &str {
        match self {
            PoolSnapshot::Cpmm { pool_address, .. } | PoolSnapshot::Whirlpool { pool_address, .. } => {
                pool_address
            }
        }
    }
    /// quote-per-base price as a fraction num/den, raw units — mirrors
    /// `midPriceNum`/`midPriceDen` in src/detect.ts exactly (one source
    /// of truth kept in sync by the parity test, not by import, since
    /// TS and Rust can't share a function).
    fn mid_price_num(&self) -> BigInt {
        match self {
            PoolSnapshot::Cpmm { quote_reserve, .. } => quote_reserve.clone(),
            PoolSnapshot::Whirlpool { sqrt_price_x64, .. } => sqrt_price_x64 * sqrt_price_x64,
        }
    }
    fn mid_price_den(&self) -> BigInt {
        match self {
            PoolSnapshot::Cpmm { base_reserve, .. } => base_reserve.clone(),
            PoolSnapshot::Whirlpool { .. } => BigInt::from(2u8).pow(128),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DetectParams {
    pub trade_size_quote: BigInt,
    pub min_profit_threshold_quote: BigInt,
    pub slippage_tolerance_bps: u16,
    pub est_tx_fee_quote: BigInt,
}

#[derive(Debug, Clone)]
pub struct ArbDirection {
    pub buy_on: String,
    pub sell_on: String,
    pub buy_pool_address: String,
    pub sell_pool_address: String,
}

#[derive(Debug, Clone)]
pub enum Decision {
    Opportunity {
        direction: ArbDirection,
        gap_bps: i64,
        quote_in: BigInt,
        base_out: BigInt,
        quote_out: BigInt,
        est_net_profit: BigInt,
        min_profit_threshold: BigInt,
    },
    NoOpportunity { gap_bps: i64, reason: String },
}

fn bps() -> BigInt {
    BigInt::from(10_000)
}

fn apply_haircut(amount: &BigInt, slippage_bps: u16) -> BigInt {
    (amount * (bps() - BigInt::from(slippage_bps))) / bps()
}

/// BigInt-domain constant-product swap output — same floor-division
/// algorithm as `crate::cpmm_amount_out`, but unbounded: an off-chain
/// estimate, not an instruction field.
fn cpmm_amount_out(amount_in: &BigInt, reserve_in: &BigInt, reserve_out: &BigInt, fee_bps: u16) -> BigInt {
    if amount_in.is_zero() {
        return BigInt::zero();
    }
    let amount_in_after_fee = amount_in * (bps() - BigInt::from(fee_bps));
    (amount_in_after_fee.clone() * reserve_out) / (reserve_in * bps() + amount_in_after_fee)
}

/// Quote tokens received for `baseIn` at spot price, fee on input —
/// mirrors `src/math/whirlpool.ts::whirlpoolBaseToQuote`.
pub fn whirlpool_base_to_quote(base_in: &BigInt, sqrt_price_x64: &BigInt, fee_bps: u16) -> BigInt {
    let q128 = BigInt::from(2u8).pow(128);
    (base_in * (bps() - BigInt::from(fee_bps)) * sqrt_price_x64 * sqrt_price_x64) / (q128 * bps())
}

/// Base tokens received for `quoteIn` at spot price, fee on input —
/// mirrors `src/math/whirlpool.ts::whirlpoolQuoteToBase`.
pub fn whirlpool_quote_to_base(quote_in: &BigInt, sqrt_price_x64: &BigInt, fee_bps: u16) -> BigInt {
    let q128 = BigInt::from(2u8).pow(128);
    (quote_in * (bps() - BigInt::from(fee_bps)) * q128) / (sqrt_price_x64 * sqrt_price_x64 * bps())
}

fn quote_to_base(snap: &PoolSnapshot, quote_in: &BigInt, slippage_bps: u16) -> BigInt {
    match snap {
        PoolSnapshot::Cpmm { quote_reserve, base_reserve, fee_bps, .. } => {
            cpmm_amount_out(quote_in, quote_reserve, base_reserve, *fee_bps)
        }
        PoolSnapshot::Whirlpool { sqrt_price_x64, fee_bps, .. } => {
            apply_haircut(&whirlpool_quote_to_base(quote_in, sqrt_price_x64, *fee_bps), slippage_bps)
        }
    }
}

fn base_to_quote(snap: &PoolSnapshot, base_in: &BigInt, slippage_bps: u16) -> BigInt {
    match snap {
        PoolSnapshot::Cpmm { base_reserve, quote_reserve, fee_bps, .. } => {
            cpmm_amount_out(base_in, base_reserve, quote_reserve, *fee_bps)
        }
        PoolSnapshot::Whirlpool { sqrt_price_x64, fee_bps, .. } => {
            apply_haircut(&whirlpool_base_to_quote(base_in, sqrt_price_x64, *fee_bps), slippage_bps)
        }
    }
}

struct LegResult<'a> {
    buy_pool: &'a PoolSnapshot,
    sell_pool: &'a PoolSnapshot,
    base_out: BigInt,
    quote_out: BigInt,
    est_net_profit: BigInt,
}

fn eval_direction<'a>(buy_pool: &'a PoolSnapshot, sell_pool: &'a PoolSnapshot, p: &DetectParams) -> LegResult<'a> {
    let base_out = quote_to_base(buy_pool, &p.trade_size_quote, p.slippage_tolerance_bps);
    let quote_out = base_to_quote(sell_pool, &base_out, p.slippage_tolerance_bps);
    let est_net_profit = &quote_out - &p.trade_size_quote - &p.est_tx_fee_quote;
    LegResult { buy_pool, sell_pool, base_out, quote_out, est_net_profit }
}

/// Signed mid-price gap of pool A relative to pool B, in basis points
/// (negative = base token is cheaper on A). Diagnostic only, exactly as
/// in `src/detect.ts` — decisions use the executable-amount math above.
fn compute_gap_bps(a: &PoolSnapshot, b: &PoolSnapshot) -> i64 {
    let num = a.mid_price_num() * b.mid_price_den() * bps();
    let den = a.mid_price_den() * b.mid_price_num();
    let ratio = (num / den).to_i64().unwrap_or(i64::MAX);
    ratio - 10_000
}

pub fn detect(a: &PoolSnapshot, b: &PoolSnapshot, p: &DetectParams) -> Result<Decision, PairMismatch> {
    if a.pair().base_mint != b.pair().base_mint || a.pair().quote_mint != b.pair().quote_mint {
        return Err(PairMismatch {
            a: (a.pair().base_mint.clone(), a.pair().quote_mint.clone()),
            b: (b.pair().base_mint.clone(), b.pair().quote_mint.clone()),
        });
    }

    let gap_bps = compute_gap_bps(a, b);

    let forward = eval_direction(a, b, p);
    let backward = eval_direction(b, a, p);
    let best = if forward.est_net_profit >= backward.est_net_profit { forward } else { backward };

    if best.est_net_profit >= p.min_profit_threshold_quote {
        Ok(Decision::Opportunity {
            direction: ArbDirection {
                buy_on: best.buy_pool.dex().to_string(),
                sell_on: best.sell_pool.dex().to_string(),
                buy_pool_address: best.buy_pool.pool_address().to_string(),
                sell_pool_address: best.sell_pool.pool_address().to_string(),
            },
            gap_bps,
            quote_in: p.trade_size_quote.clone(),
            base_out: best.base_out,
            quote_out: best.quote_out,
            est_net_profit: best.est_net_profit,
            min_profit_threshold: p.min_profit_threshold_quote.clone(),
        })
    } else {
        Ok(Decision::NoOpportunity {
            gap_bps,
            reason: format!(
                "best direction (buy {}, sell {}) nets {} quote units, below threshold {}",
                best.buy_pool.dex(),
                best.sell_pool.dex(),
                best.est_net_profit,
                p.min_profit_threshold_quote
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q64_EXP: u32 = 64;

    fn q64() -> BigInt {
        BigInt::from(2u8).pow(Q64_EXP)
    }

    fn pair() -> PairInfo {
        PairInfo {
            base_mint: "So11111111111111111111111111111111111111112".into(),
            quote_mint: "USDC-mint".into(),
        }
    }

    fn whirl(sqrt_price_x64: BigInt, fee_bps: u16) -> PoolSnapshot {
        PoolSnapshot::Whirlpool {
            dex: "orca-whirlpool".into(),
            pool_address: "OrcaPool111".into(),
            pair: pair(),
            sqrt_price_x64,
            fee_bps,
        }
    }

    fn params(min_profit_threshold_quote: i64, slippage_tolerance_bps: u16, est_tx_fee_quote: i64) -> DetectParams {
        DetectParams {
            trade_size_quote: BigInt::from(1_000_000),
            min_profit_threshold_quote: BigInt::from(min_profit_threshold_quote),
            slippage_tolerance_bps,
            est_tx_fee_quote: BigInt::from(est_tx_fee_quote),
        }
    }

    // 1e12 as BigInt without i64 overflow.
    fn big(s: &str) -> BigInt {
        s.parse().unwrap()
    }

    #[test]
    fn no_opportunity_when_venues_price_identically() {
        let d = detect(&cpmm2(big("1000000000000"), big("1000000000000"), 0), &whirl(q64(), 0), &params(10_000, 0, 0)).unwrap();
        match d {
            Decision::NoOpportunity { gap_bps, .. } => assert!(gap_bps.abs() < 2),
            _ => panic!("expected no-opportunity"),
        }
    }

    fn cpmm2(base_reserve: BigInt, quote_reserve: BigInt, fee_bps: u16) -> PoolSnapshot {
        PoolSnapshot::Cpmm {
            dex: "raydium-cpmm".into(),
            pool_address: "RayPool111".into(),
            pair: pair(),
            base_reserve,
            quote_reserve,
            fee_bps,
        }
    }

    #[test]
    fn buy_cpmm_sell_whirlpool_exact_known_profit() {
        let d = detect(
            &cpmm2(big("1000000000000"), big("800000000000"), 0),
            &whirl(q64(), 0),
            &params(10_000, 0, 0),
        )
        .unwrap();
        match d {
            Decision::Opportunity { direction, quote_in, base_out, quote_out, est_net_profit, .. } => {
                assert_eq!(direction.buy_on, "raydium-cpmm");
                assert_eq!(direction.sell_on, "orca-whirlpool");
                assert_eq!(quote_in, BigInt::from(1_000_000));
                assert_eq!(base_out, BigInt::from(1_249_998));
                assert_eq!(quote_out, BigInt::from(1_249_998));
                assert_eq!(est_net_profit, BigInt::from(249_998));
            }
            _ => panic!("expected opportunity"),
        }
    }

    #[test]
    fn reverse_direction_base_cheap_on_whirlpool() {
        let d = detect(
            &cpmm2(big("1000000000000"), big("1250000000000"), 0),
            &whirl(q64(), 0),
            &params(10_000, 0, 0),
        )
        .unwrap();
        match d {
            Decision::Opportunity { direction, est_net_profit, .. } => {
                assert_eq!(direction.buy_on, "orca-whirlpool");
                assert_eq!(direction.sell_on, "raydium-cpmm");
                assert!(est_net_profit > BigInt::zero());
            }
            _ => panic!("expected opportunity"),
        }
    }

    #[test]
    fn respects_min_profit_threshold_as_exact_boundary() {
        let base = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(249_998, 0, 0)).unwrap();
        assert!(matches!(base, Decision::Opportunity { .. }));

        let above = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(249_999, 0, 0)).unwrap();
        assert!(matches!(above, Decision::NoOpportunity { .. }));
    }

    #[test]
    fn estimated_tx_fee_is_subtracted_from_net_profit() {
        let no_fee = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(10_000, 0, 0)).unwrap();
        let with_fee = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(10_000, 0, 100_000)).unwrap();
        let profit = |d: Decision| match d {
            Decision::Opportunity { est_net_profit, .. } => est_net_profit,
            _ => panic!("expected opportunity"),
        };
        assert_eq!(profit(no_fee) - profit(with_fee), BigInt::from(100_000));
    }

    #[test]
    fn slippage_buffer_reduces_profit_and_can_kill_the_trade() {
        let tight = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(10_000, 50, 0)).unwrap();
        let loose = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(10_000, 0, 0)).unwrap();
        let profit = |d: &Decision| match d {
            Decision::Opportunity { est_net_profit, .. } => est_net_profit.clone(),
            _ => panic!("expected opportunity"),
        };
        assert!(profit(&tight) < profit(&loose));

        let killed = detect(&cpmm2(big("1000000000000"), big("800000000000"), 0), &whirl(q64(), 0), &params(10_000, 5_000, 0)).unwrap();
        assert!(matches!(killed, Decision::NoOpportunity { .. }));
    }

    #[test]
    fn throws_if_snapshots_are_for_different_pairs() {
        let mut other = cpmm2(big("1000000000000"), big("1000000000000"), 0);
        if let PoolSnapshot::Cpmm { pair, .. } = &mut other {
            pair.quote_mint = "USDT-mint".into();
        }
        let err = detect(&other, &whirl(q64(), 0), &params(10_000, 0, 0)).unwrap_err();
        assert!(err.to_string().contains("different pairs"));
    }
}
