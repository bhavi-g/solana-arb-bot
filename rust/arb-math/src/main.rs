//! JSON-over-stdio CLI boundary for the TS bot (see `src/rustmath.ts`).
//! One request in on stdin, one response out on stdout.
//!
//! u64 amounts cross as decimal strings, not JSON numbers: JS's JSON
//! numbers are IEEE-754 doubles with 53 bits of safe integer precision,
//! short of u64's 64 — a reserve or trade size for a low-decimal token
//! can exceed that, so a plain JSON number would silently round. `fee_bps`
//! is always small (<=10000) so it stays a plain number. The library
//! functions (`arb_math::*`) take real `u64`s; parsing happens only here,
//! at the process boundary.

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::str::FromStr;

use arb_math::detect::{self as detect_mod, DetectParams, PairInfo, PoolSnapshot};
use arb_math::{cpmm_amount_out, min_quote_out};

/// One pool snapshot as it crosses the JSON boundary, camelCase to match
/// `src/types.ts::PoolSnapshot` directly — unlike the `cpmm_amount_out`/
/// `min_quote_out` ops (snake_case, standalone scalars), `detect` passes
/// the bot's own snapshot/decision shapes so `src/rustmath.ts` can hand
/// them back out as a drop-in `Decision` (see ADR-0012).
#[derive(Deserialize)]
struct SnapshotDto {
    kind: String,
    dex: String,
    #[serde(rename = "poolAddress")]
    pool_address: String,
    #[serde(rename = "baseMint")]
    base_mint: String,
    #[serde(rename = "quoteMint")]
    quote_mint: String,
    #[serde(rename = "feeBps")]
    fee_bps: u16,
    #[serde(rename = "baseReserve", default)]
    base_reserve: Option<String>,
    #[serde(rename = "quoteReserve", default)]
    quote_reserve: Option<String>,
    #[serde(rename = "sqrtPriceX64", default)]
    sqrt_price_x64: Option<String>,
}

impl SnapshotDto {
    fn into_snapshot(self) -> Result<PoolSnapshot, String> {
        let pair = PairInfo { base_mint: self.base_mint, quote_mint: self.quote_mint };
        match self.kind.as_str() {
            "cpmm" => Ok(PoolSnapshot::Cpmm {
                dex: self.dex,
                pool_address: self.pool_address,
                pair,
                base_reserve: parse_bigint(&required(self.base_reserve, "baseReserve")?, "baseReserve")?,
                quote_reserve: parse_bigint(&required(self.quote_reserve, "quoteReserve")?, "quoteReserve")?,
                fee_bps: self.fee_bps,
            }),
            "whirlpool" => Ok(PoolSnapshot::Whirlpool {
                dex: self.dex,
                pool_address: self.pool_address,
                pair,
                sqrt_price_x64: parse_bigint(&required(self.sqrt_price_x64, "sqrtPriceX64")?, "sqrtPriceX64")?,
                fee_bps: self.fee_bps,
            }),
            other => Err(format!("unknown snapshot kind \"{other}\"")),
        }
    }
}

fn required(field: Option<String>, name: &str) -> Result<String, String> {
    field.ok_or_else(|| format!("missing field `{name}` for this snapshot kind"))
}

fn parse_bigint(s: &str, field: &str) -> Result<BigInt, String> {
    BigInt::from_str(s).map_err(|e| format!("field `{field}` is not a valid integer (\"{s}\"): {e}"))
}

fn parse_u64(s: &str, field: &str) -> Result<u64, String> {
    s.parse::<u64>()
        .map_err(|e| format!("field `{field}` is not a valid u64 (\"{s}\"): {e}"))
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    CpmmAmountOut {
        amount_in: String,
        reserve_in: String,
        reserve_out: String,
        fee_bps: u16,
    },
    MinQuoteOut {
        quote_in: String,
        min_profit_threshold: String,
    },
    Detect {
        a: SnapshotDto,
        b: SnapshotDto,
        #[serde(rename = "tradeSizeQuote")]
        trade_size_quote: String,
        #[serde(rename = "minProfitThresholdQuote")]
        min_profit_threshold_quote: String,
        #[serde(rename = "slippageToleranceBps")]
        slippage_tolerance_bps: u16,
        #[serde(rename = "estTxFeeQuote")]
        est_tx_fee_quote: String,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Value(Value),
    Err { error: String },
}

fn decision_to_json(d: detect_mod::Decision) -> Value {
    match d {
        detect_mod::Decision::Opportunity {
            direction,
            gap_bps,
            quote_in,
            base_out,
            quote_out,
            est_net_profit,
            min_profit_threshold,
        } => json!({
            "decision": "opportunity",
            "direction": {
                "buyOn": direction.buy_on,
                "sellOn": direction.sell_on,
                "buyPoolAddress": direction.buy_pool_address,
                "sellPoolAddress": direction.sell_pool_address,
            },
            "gapBps": gap_bps,
            "quoteIn": quote_in.to_string(),
            "baseOut": base_out.to_string(),
            "quoteOut": quote_out.to_string(),
            "estNetProfit": est_net_profit.to_string(),
            "minProfitThreshold": min_profit_threshold.to_string(),
        }),
        detect_mod::Decision::NoOpportunity { gap_bps, reason } => json!({
            "decision": "no-opportunity",
            "gapBps": gap_bps,
            "reason": reason,
        }),
    }
}

fn run(request: Request) -> Result<Value, String> {
    match request {
        Request::CpmmAmountOut {
            amount_in,
            reserve_in,
            reserve_out,
            fee_bps,
        } => {
            let amount_in = parse_u64(&amount_in, "amount_in")?;
            let reserve_in = parse_u64(&reserve_in, "reserve_in")?;
            let reserve_out = parse_u64(&reserve_out, "reserve_out")?;
            let out = cpmm_amount_out(amount_in, reserve_in, reserve_out, fee_bps).map_err(|e| e.to_string())?;
            Ok(json!({ "result": out.to_string() }))
        }
        Request::MinQuoteOut {
            quote_in,
            min_profit_threshold,
        } => {
            let quote_in = parse_u64(&quote_in, "quote_in")?;
            let min_profit_threshold = parse_u64(&min_profit_threshold, "min_profit_threshold")?;
            let out = min_quote_out(quote_in, min_profit_threshold).map_err(|e| e.to_string())?;
            Ok(json!({ "result": out.to_string() }))
        }
        Request::Detect {
            a,
            b,
            trade_size_quote,
            min_profit_threshold_quote,
            slippage_tolerance_bps,
            est_tx_fee_quote,
        } => {
            let params = DetectParams {
                trade_size_quote: parse_bigint(&trade_size_quote, "tradeSizeQuote")?,
                min_profit_threshold_quote: parse_bigint(&min_profit_threshold_quote, "minProfitThresholdQuote")?,
                slippage_tolerance_bps,
                est_tx_fee_quote: parse_bigint(&est_tx_fee_quote, "estTxFeeQuote")?,
            };
            let a = a.into_snapshot()?;
            let b = b.into_snapshot()?;
            let decision = detect_mod::detect(&a, &b, &params).map_err(|e| e.to_string())?;
            Ok(decision_to_json(decision))
        }
    }
}

fn emit(r: Response) {
    let s = serde_json::to_string(&r).expect("response always serializes");
    let mut stdout = io::stdout();
    let _ = stdout.write_all(s.as_bytes());
    let _ = stdout.write_all(b"\n");
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {e}");
        std::process::exit(1);
    }

    let request: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::Err {
                error: format!("invalid request: {e}"),
            });
            std::process::exit(1);
        }
    };

    match run(request) {
        Ok(value) => emit(Response::Value(value)),
        Err(error) => {
            emit(Response::Err { error });
            std::process::exit(1);
        }
    }
}
