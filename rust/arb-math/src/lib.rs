//! Pure arbitrage safety math, ported from `src/math/cpmm.ts` and the
//! minimum-out guard in `src/txbuilder/index.ts` (ADR-0011). Both take
//! and return `u64` because that's the real on-chain width of an SPL
//! token amount (`amountIn` / `minimumAmountOut` on the swap
//! instruction) — unlike the TS side's `bigint`, this type can't
//! silently represent a value no real instruction ever could, and
//! every operation is checked so overflow surfaces as an error instead
//! of wrapping.

use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum MathError {
    ZeroReserve,
    FeeOutOfRange,
    Overflow,
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MathError::ZeroReserve => write!(f, "reserves must be > 0"),
            MathError::FeeOutOfRange => write!(f, "feeBps must be in [0, 10000]"),
            MathError::Overflow => write!(f, "arithmetic overflow"),
        }
    }
}

impl std::error::Error for MathError {}

const BPS_DENOMINATOR: u128 = 10_000;

/// Constant-product (x*y=k) swap output, fee charged on input, floor
/// division — mirrors `src/math/cpmm.ts::getAmountOut` exactly
/// (Uniswap-v2 style: rounding always favors the pool, so the estimate
/// is conservative).
pub fn cpmm_amount_out(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u16,
) -> Result<u64, MathError> {
    if reserve_in == 0 || reserve_out == 0 {
        return Err(MathError::ZeroReserve);
    }
    if fee_bps as u128 > BPS_DENOMINATOR {
        return Err(MathError::FeeOutOfRange);
    }
    if amount_in == 0 {
        return Ok(0);
    }

    let amount_in_after_fee = (amount_in as u128) * (BPS_DENOMINATOR - fee_bps as u128);
    let numerator = amount_in_after_fee
        .checked_mul(reserve_out as u128)
        .ok_or(MathError::Overflow)?;
    let denominator = (reserve_in as u128) * BPS_DENOMINATOR + amount_in_after_fee;

    let out = numerator / denominator;
    u64::try_from(out).map_err(|_| MathError::Overflow)
}

/// The on-chain atomic revert guard (ADR-0011 / resume bullet 1): the
/// sell leg's minimum acceptable output is the quote paid back plus the
/// configured profit threshold. If live state moved and the real
/// output no longer clears this, the instruction — and the whole
/// transaction — reverts, so the only loss is the base fee, never a
/// one-legged position.
pub fn min_quote_out(quote_in: u64, min_profit_threshold: u64) -> Result<u64, MathError> {
    quote_in
        .checked_add(min_profit_threshold)
        .ok_or(MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors tests/cpmm.test.ts so the Rust port is verified against
    // the exact same input vectors as the TS implementation it replaces.

    #[test]
    fn classic_no_fee_case() {
        assert_eq!(cpmm_amount_out(1000, 1_000_000, 1_000_000, 0).unwrap(), 999);
    }

    #[test]
    fn thirty_bps_fee() {
        assert_eq!(cpmm_amount_out(1000, 1_000_000, 1_000_000, 30).unwrap(), 996);
    }

    #[test]
    fn fee_strictly_reduces_output() {
        let no_fee = cpmm_amount_out(50_000, 2_000_000, 8_000_000, 0).unwrap();
        let with_fee = cpmm_amount_out(50_000, 2_000_000, 8_000_000, 25).unwrap();
        assert!(with_fee < no_fee);
    }

    #[test]
    fn monotonic_in_input() {
        let small = cpmm_amount_out(1_000, 1_000_000, 1_000_000, 25).unwrap();
        let large = cpmm_amount_out(2_000, 1_000_000, 1_000_000, 25).unwrap();
        assert!(large > small);
    }

    #[test]
    fn never_drains_full_opposite_reserve_even_for_huge_input() {
        let out = cpmm_amount_out(1_000_000_000_000_000_000, 1_000_000, 1_000_000, 0).unwrap();
        assert!(out < 1_000_000);
    }

    #[test]
    fn preserves_or_grows_k() {
        let x: u128 = 3_333_333;
        let y: u128 = 7_777_777;
        let dx: u64 = 123_456;
        let out = cpmm_amount_out(dx, x as u64, y as u64, 25).unwrap();
        let k_before = x * y;
        let k_after = (x + dx as u128) * (y - out as u128);
        assert!(k_after >= k_before);
    }

    #[test]
    fn zero_input_is_zero() {
        assert_eq!(cpmm_amount_out(0, 1_000_000, 1_000_000, 25).unwrap(), 0);
    }

    #[test]
    fn full_fee_drains_to_zero() {
        assert_eq!(
            cpmm_amount_out(1000, 1_000_000, 1_000_000, 10_000).unwrap(),
            0
        );
    }

    #[test]
    fn rejects_zero_reserves() {
        assert_eq!(
            cpmm_amount_out(100, 0, 1_000_000, 25),
            Err(MathError::ZeroReserve)
        );
        assert_eq!(
            cpmm_amount_out(100, 1_000_000, 0, 25),
            Err(MathError::ZeroReserve)
        );
    }

    #[test]
    fn rejects_fee_out_of_range() {
        assert_eq!(
            cpmm_amount_out(100, 1_000_000, 1_000_000, 10_001),
            Err(MathError::FeeOutOfRange)
        );
    }

    #[test]
    fn extreme_reserves_overflow_is_caught_not_wrapped() {
        // amount_in_after_fee * reserve_out can exceed u128 when both
        // amount_in and reserve_out sit near u64::MAX — must error, not
        // silently wrap to a small (wrong, profitable-looking) number.
        let result = cpmm_amount_out(u64::MAX, 1, u64::MAX, 0);
        assert_eq!(result, Err(MathError::Overflow));
    }

    #[test]
    fn min_quote_out_adds_threshold_to_quote_in() {
        assert_eq!(min_quote_out(1_000_000, 50_000).unwrap(), 1_050_000);
    }

    #[test]
    fn min_quote_out_zero_threshold_is_identity() {
        assert_eq!(min_quote_out(42, 0).unwrap(), 42);
    }

    #[test]
    fn min_quote_out_rejects_overflow() {
        assert_eq!(min_quote_out(u64::MAX, 1), Err(MathError::Overflow));
    }
}
