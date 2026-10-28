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

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

use arb_math::{cpmm_amount_out, min_quote_out};

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
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Ok { result: String },
    Err { error: String },
}

fn parse_u64(s: &str, field: &str) -> Result<u64, String> {
    s.parse::<u64>()
        .map_err(|e| format!("field `{field}` is not a valid u64 (\"{s}\"): {e}"))
}

fn run(request: Request) -> Result<u64, String> {
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
            cpmm_amount_out(amount_in, reserve_in, reserve_out, fee_bps).map_err(|e| e.to_string())
        }
        Request::MinQuoteOut {
            quote_in,
            min_profit_threshold,
        } => {
            let quote_in = parse_u64(&quote_in, "quote_in")?;
            let min_profit_threshold = parse_u64(&min_profit_threshold, "min_profit_threshold")?;
            min_quote_out(quote_in, min_profit_threshold).map_err(|e| e.to_string())
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
        Ok(value) => emit(Response::Ok {
            result: value.to_string(),
        }),
        Err(error) => {
            emit(Response::Err { error });
            std::process::exit(1);
        }
    }
}
