/**
 * READ-ONLY spread survey. Sends nothing, signs nothing, needs no keypair.
 *
 * Purpose: answer "is there ANY venue whose observed cross-pool price gap
 * actually exceeds its own round-trip fee floor" — cheaply, across many
 * pairs at once — before committing another 72h shadow run to a single
 * venue.
 *
 * Why this exists: the `clmm-orca` Phase-2 run (ADR-0010) returned 0/0/0
 * over 84.7h. Re-reading its 55,245 logged cycles shows why, and it is not
 * "we got unlucky": the observed SOL/USDC gap was 0-1 bps in 93.4% of
 * cycles and NEVER exceeded 6 bps, against an 8 bps round-trip pool-fee
 * floor (Raydium CLMM 4 + Orca 4). Gross spread never cleared fees even
 * once, so no threshold, slippage, or trade-size retune could have made a
 * profitable cycle appear. More hours on that pair samples the same dead
 * band again. This script looks for a pair where the band is actually
 * wider than the fees, and reports the evidence either way.
 *
 * The bar a venue must clear here is deliberately the LOOSEST possible
 * one — gross gap > pool fees alone, ignoring tx fee, priority fee, tip,
 * and price impact. A venue that cannot clear even this cannot possibly be
 * profitable, so failing it is conclusive; passing it is necessary but not
 * sufficient, and earns a full shadow run rather than a go decision.
 *
 * Fees and prices are decoded from live on-chain accounts (the project's
 * standing rule: never trust a remembered or API-reported constant). The
 * public pool lists are used ONLY to enumerate candidate addresses; every
 * number that feeds a verdict is read from the chain.
 *
 * Usage:
 *   npx tsx scripts/survey-spreads.ts                  # 120 min, defaults
 *   SURVEY_MINUTES=30 npx tsx scripts/survey-spreads.ts
 *   MIN_TVL_USD=1000000 SURVEY_MINUTES=240 npx tsx scripts/survey-spreads.ts
 *
 * Env:
 *   HELIUS_API_KEY | MAINNET_RPC_URL   RPC (mainnet, read-only)
 *   SURVEY_MINUTES     default 120   how long to sample
 *   SAMPLE_INTERVAL_MS default 2000  delay between sample rounds
 *   MIN_TVL_USD        default 250000  per-pool TVL floor (both legs)
 *   MAX_VENUES         default 60    cap on venues surveyed
 *   OUT_DIR            default logs
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { createWriteStream, mkdirSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { decodeWhirlpool, type WhirlpoolState } from "../src/decode/orcaWhirlpool.js";
import {
  decodeClmmPool,
  decodeClmmAmmConfigFeeBps,
  type ClmmPoolState,
} from "../src/decode/clmm.js";

const SURVEY_MINUTES = Number(process.env.SURVEY_MINUTES ?? 120);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 2000);
const MIN_TVL_USD = Number(process.env.MIN_TVL_USD ?? 250_000);
const MAX_VENUES = Number(process.env.MAX_VENUES ?? 60);
const OUT_DIR = process.env.OUT_DIR ?? "logs";

/** getMultipleAccounts hard limit per request. */
const ACCOUNTS_PER_REQUEST = 100;

type Dex = "orca-whirlpool" | "raydium-clmm";

interface Pool {
  address: string;
  dex: Dex;
  /** Canonical "mint0/mint1" key; both DEXes store mints in sorted order. */
  pairKey: string;
  mint0: string;
  mint1: string;
  symbol: string;
  tvlUsd: number;
  /** Filled in during on-chain resolution. */
  feeBps?: number;
  ammConfig?: string;
  liquidity?: bigint;
  sqrtPriceX64?: bigint;
}

interface Venue {
  id: string;
  pairKey: string;
  symbol: string;
  a: Pool;
  b: Pool;
  /** Round-trip pool fee in bps — the loosest possible break-even bar. */
  feeFloorBps: number;
  samples: number[];
}

/**
 * Per-pool price-movement tracking, to catch the survey's main false
 * positive: a pool whose sqrtPrice is FROZEN.
 *
 * A concentrated pool can report healthy list TVL while holding no
 * liquidity at the current tick, or hold a token that nobody trades. Its
 * last-traded sqrtPrice then sits unchanged for days, and comparing it
 * against a live pool manufactures an enormous, rock-steady "gap" that no
 * one can capture — the tell is p50 == p99 == max, a spread that never
 * breathes. Counting distinct price updates separates a live venue from a
 * frozen one far more reliably than any TVL threshold.
 */
interface Movement {
  updates: number;
  last?: bigint;
}

function rpcUrl(): string {
  const explicit = process.env.MAINNET_RPC_URL;
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY;
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  throw new Error("set HELIUS_API_KEY or MAINNET_RPC_URL");
}

function pairKeyOf(m0: string, m1: string): string {
  return `${m0}/${m1}`;
}

/** Candidate Orca whirlpools from the public list (addresses only). */
async function listOrcaPools(): Promise<Pool[]> {
  const resp = await fetch("https://api.mainnet.orca.so/v1/whirlpool/list");
  if (!resp.ok) throw new Error(`orca list HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    whirlpools: Array<{
      address: string;
      tokenA: { mint: string; symbol?: string };
      tokenB: { mint: string; symbol?: string };
      tvl?: number;
    }>;
  };
  return body.whirlpools
    .filter((w) => (w.tvl ?? 0) >= MIN_TVL_USD)
    .map((w) => ({
      address: w.address,
      dex: "orca-whirlpool" as const,
      pairKey: pairKeyOf(w.tokenA.mint, w.tokenB.mint),
      mint0: w.tokenA.mint,
      mint1: w.tokenB.mint,
      symbol: `${w.tokenA.symbol ?? "?"}/${w.tokenB.symbol ?? "?"}`,
      tvlUsd: w.tvl ?? 0,
    }));
}

/** Candidate Raydium CLMM pools from the public list (addresses only). */
async function listRaydiumClmmPools(): Promise<Pool[]> {
  const url =
    "https://api-v3.raydium.io/pools/info/list?poolType=concentrated" +
    "&poolSortField=liquidity&sortType=desc&pageSize=1000&page=1";
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`raydium list HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    success: boolean;
    data?: {
      data?: Array<{
        id: string;
        mintA: { address: string; symbol?: string };
        mintB: { address: string; symbol?: string };
        tvl?: number;
      }>;
    };
  };
  if (!body.success || !body.data?.data) throw new Error("raydium list: bad body");
  return body.data.data
    .filter((p) => (p.tvl ?? 0) >= MIN_TVL_USD)
    .map((p) => ({
      address: p.id,
      dex: "raydium-clmm" as const,
      pairKey: pairKeyOf(p.mintA.address, p.mintB.address),
      mint0: p.mintA.address,
      mint1: p.mintB.address,
      symbol: `${p.mintA.symbol ?? "?"}/${p.mintB.symbol ?? "?"}`,
      tvlUsd: p.tvl ?? 0,
    }));
}

async function fetchAccounts(
  connection: Connection,
  keys: string[],
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < keys.length; i += ACCOUNTS_PER_REQUEST) {
    const chunk = keys.slice(i, i + ACCOUNTS_PER_REQUEST);
    const infos = await connection.getMultipleAccountsInfo(
      chunk.map((k) => new PublicKey(k)),
    );
    infos.forEach((info, j) => {
      if (info) out.set(chunk[j]!, info.data);
    });
  }
  return out;
}

/**
 * Read every candidate pool's real state from chain. Drops any pool whose
 * account is missing, undecodable, or whose on-chain mints disagree with
 * the list's (a stale list entry must never silently define a venue).
 */
async function resolveOnChain(connection: Connection, pools: Pool[]): Promise<Pool[]> {
  const accounts = await fetchAccounts(
    connection,
    pools.map((p) => p.address),
  );

  const resolved: Pool[] = [];
  const clmmNeedingConfig: Pool[] = [];

  for (const pool of pools) {
    const data = accounts.get(pool.address);
    if (!data) continue;
    try {
      if (pool.dex === "orca-whirlpool") {
        const w: WhirlpoolState = decodeWhirlpool(data);
        if (
          w.tokenMintA.toBase58() !== pool.mint0 ||
          w.tokenMintB.toBase58() !== pool.mint1
        ) {
          continue;
        }
        resolved.push({
          ...pool,
          feeBps: w.feeBps,
          liquidity: w.liquidity,
          sqrtPriceX64: w.sqrtPriceX64,
        });
      } else {
        const c: ClmmPoolState = decodeClmmPool(data);
        if (
          c.tokenMint0.toBase58() !== pool.mint0 ||
          c.tokenMint1.toBase58() !== pool.mint1
        ) {
          continue;
        }
        const withState: Pool = {
          ...pool,
          ammConfig: c.ammConfig.toBase58(),
          liquidity: c.liquidity,
          sqrtPriceX64: c.sqrtPriceX64,
        };
        clmmNeedingConfig.push(withState);
      }
    } catch {
      // Undecodable account layout — skip rather than guess.
    }
  }

  // CLMM fees live in the referenced AmmConfig, not the pool (src/decode/clmm.ts).
  // They are effectively static, so one batch read up front is enough.
  const configKeys = [...new Set(clmmNeedingConfig.map((p) => p.ammConfig!))];
  const configs = await fetchAccounts(connection, configKeys);
  for (const pool of clmmNeedingConfig) {
    const data = configs.get(pool.ammConfig!);
    if (!data) continue;
    try {
      resolved.push({ ...pool, feeBps: decodeClmmAmmConfigFeeBps(data) });
    } catch {
      // Skip a pool whose fee we cannot read — a guessed fee floor is worse
      // than no venue at all.
    }
  }
  // Zero in-range liquidity means the pool cannot fill a swap at the current
  // price at any size: its quoted price is a leftover, not an offer.
  return resolved.filter((p) => (p.liquidity ?? 0n) > 0n);
}

/** Every same-pair pool combination that could be arbed against itself. */
function buildVenues(pools: Pool[]): Venue[] {
  const byPair = new Map<string, Pool[]>();
  for (const p of pools) {
    const list = byPair.get(p.pairKey);
    if (list) list.push(p);
    else byPair.set(p.pairKey, [p]);
  }

  const venues: Venue[] = [];
  for (const [pairKey, group] of byPair) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        venues.push({
          id: `${a.dex}:${a.address.slice(0, 6)} vs ${b.dex}:${b.address.slice(0, 6)}`,
          pairKey,
          symbol: a.symbol,
          a,
          b,
          feeFloorBps: a.feeBps! + b.feeBps!,
          samples: [],
        });
      }
    }
  }

  // Rank by the thinner leg's TVL: a venue is only as executable as its
  // shallower side, so that is what decides which venues earn a slot.
  venues.sort((x, y) => Math.min(y.a.tvlUsd, y.b.tvlUsd) - Math.min(x.a.tvlUsd, x.b.tvlUsd));
  return venues.slice(0, MAX_VENUES);
}

/**
 * Mid-price gap in bps between two same-pair pools.
 *
 * Both DEXes store sqrt(price) as Q64.64 of mint1-per-mint0 in RAW units,
 * and the pools share a pair, so decimals cancel entirely and the ratio can
 * be taken directly. float64 carries ~15 significant digits against a 1 bp
 * signal of 1e-4, so the precision margin is ~11 orders of magnitude.
 */
function gapBps(sqrtA: bigint, sqrtB: bigint): number {
  const ratio = Number(sqrtA) / Number(sqrtB);
  return (ratio * ratio - 1) * 10_000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx]!;
}

interface VenueReport {
  id: string;
  symbol: string;
  pairKey: string;
  poolA: string;
  poolB: string;
  dexA: Dex;
  dexB: Dex;
  feeABps: number;
  feeBBps: number;
  feeFloorBps: number;
  tvlAUsd: number;
  tvlBUsd: number;
  samples: number;
  absGapP50: number;
  absGapP95: number;
  absGapP99: number;
  absGapMax: number;
  clearedCount: number;
  clearedFraction: number;
  bestExcessBps: number;
  updatesA: number;
  updatesB: number;
  /** Either leg's price never moved during the window — gap is an artifact. */
  stale: boolean;
}

function report(venue: Venue, movement: Map<string, Movement>): VenueReport {
  const abs = venue.samples.map(Math.abs).sort((x, y) => x - y);
  const cleared = abs.filter((g) => g > venue.feeFloorBps).length;
  const max = abs.length > 0 ? abs[abs.length - 1]! : NaN;
  const updatesA = movement.get(venue.a.address)?.updates ?? 0;
  const updatesB = movement.get(venue.b.address)?.updates ?? 0;
  return {
    updatesA,
    updatesB,
    stale: updatesA === 0 || updatesB === 0,
    id: venue.id,
    symbol: venue.symbol,
    pairKey: venue.pairKey,
    poolA: venue.a.address,
    poolB: venue.b.address,
    dexA: venue.a.dex,
    dexB: venue.b.dex,
    feeABps: venue.a.feeBps!,
    feeBBps: venue.b.feeBps!,
    feeFloorBps: venue.feeFloorBps,
    tvlAUsd: Math.round(venue.a.tvlUsd),
    tvlBUsd: Math.round(venue.b.tvlUsd),
    samples: abs.length,
    absGapP50: Number(percentile(abs, 0.5).toFixed(3)),
    absGapP95: Number(percentile(abs, 0.95).toFixed(3)),
    absGapP99: Number(percentile(abs, 0.99).toFixed(3)),
    absGapMax: Number(max.toFixed(3)),
    clearedCount: cleared,
    clearedFraction: abs.length ? cleared / abs.length : 0,
    bestExcessBps: Number((max - venue.feeFloorBps).toFixed(3)),
  };
}

function printTable(reports: VenueReport[], limit: number): void {
  const rows = reports.slice(0, limit);
  console.log(
    "\n  " +
      "pair".padEnd(16) +
      "venue".padEnd(12) +
      "fee".padStart(6) +
      "p50".padStart(8) +
      "p99".padStart(8) +
      "max".padStart(8) +
      "cleared".padStart(10) +
      "  min TVL" +
      "  moves",
  );
  for (const r of rows) {
    const venueTag = `${r.dexA === "orca-whirlpool" ? "orca" : "clmm"}/${
      r.dexB === "orca-whirlpool" ? "orca" : "clmm"
    }`;
    const clearedTag =
      r.clearedCount > 0
        ? `${(r.clearedFraction * 100).toFixed(2)}%`
        : "—";
    const minTvl = Math.min(r.tvlAUsd, r.tvlBUsd);
    console.log(
      "  " +
        r.symbol.slice(0, 15).padEnd(16) +
        venueTag.padEnd(12) +
        `${r.feeFloorBps}`.padStart(6) +
        r.absGapP50.toFixed(2).padStart(8) +
        r.absGapP99.toFixed(2).padStart(8) +
        r.absGapMax.toFixed(2).padStart(8) +
        clearedTag.padStart(10) +
        `  $${(minTvl / 1_000_000).toFixed(2)}M`.padStart(9) +
        `  ${r.updatesA}/${r.updatesB}` +
        (r.stale ? "  ⚠ STALE LEG" : ""),
    );
  }
}

async function main(): Promise<void> {
  const connection = new Connection(rpcUrl(), "processed");
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `[survey] READ-ONLY spread survey — no keypair, no sends. ` +
      `${SURVEY_MINUTES}min @ ${SAMPLE_INTERVAL_MS}ms, TVL floor $${MIN_TVL_USD.toLocaleString()}`,
  );

  const [orca, raydium] = await Promise.all([listOrcaPools(), listRaydiumClmmPools()]);
  console.log(
    `[survey] candidates above TVL floor: ${orca.length} Orca whirlpools, ` +
      `${raydium.length} Raydium CLMM pools`,
  );

  const resolved = await resolveOnChain(connection, [...orca, ...raydium]);
  console.log(`[survey] ${resolved.length} pools resolved + fee-decoded on-chain`);

  const venues = buildVenues(resolved);
  if (venues.length === 0) {
    console.log("[survey] no same-pair pool combinations found — nothing to survey.");
    return;
  }
  console.log(`[survey] surveying ${venues.length} venue(s):`);
  for (const v of venues.slice(0, 15)) {
    console.log(
      `  ${v.symbol.padEnd(16)} ${v.a.dex}(${v.a.feeBps}bps) vs ${v.b.dex}(${v.b.feeBps}bps)` +
        `  fee floor ${v.feeFloorBps}bps`,
    );
  }
  if (venues.length > 15) console.log(`  … and ${venues.length - 15} more`);

  const addresses = [...new Set(venues.flatMap((v) => [v.a.address, v.b.address]))];
  console.log(
    `[survey] ${addresses.length} unique pool accounts, ` +
      `${Math.ceil(addresses.length / ACCOUNTS_PER_REQUEST)} RPC call(s) per round\n`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const samplePath = `${OUT_DIR}/survey-${stamp}.jsonl`;
  const reportPath = `${OUT_DIR}/survey-${stamp}.report.json`;
  const sink = createWriteStream(samplePath, { flags: "a" });

  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[survey] stopping after current round…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deadline = Date.now() + SURVEY_MINUTES * 60_000;
  const movement = new Map<string, Movement>();
  let rounds = 0;
  let failures = 0;
  let lastProgressAt = 0;

  while (!stopping && Date.now() < deadline) {
    const roundStart = Date.now();
    try {
      const accounts = await fetchAccounts(connection, addresses);
      const prices = new Map<string, bigint>();
      for (const [address, data] of accounts) {
        try {
          // Decoder choice follows the venue's declared dex, never a guess
          // from the account contents.
          const dex = venues.find(
            (v) => v.a.address === address || v.b.address === address,
          );
          if (!dex) continue;
          const isOrca =
            (dex.a.address === address && dex.a.dex === "orca-whirlpool") ||
            (dex.b.address === address && dex.b.dex === "orca-whirlpool");
          const sqrtPrice = isOrca
            ? decodeWhirlpool(data).sqrtPriceX64
            : decodeClmmPool(data).sqrtPriceX64;
          prices.set(address, sqrtPrice);

          const seen = movement.get(address);
          if (!seen) movement.set(address, { updates: 0, last: sqrtPrice });
          else if (seen.last !== sqrtPrice) {
            seen.updates++;
            seen.last = sqrtPrice;
          }
        } catch {
          // Skip this pool for this round.
        }
      }

      const ts = new Date().toISOString();
      for (const v of venues) {
        const sa = prices.get(v.a.address);
        const sb = prices.get(v.b.address);
        if (sa === undefined || sb === undefined || sa === 0n || sb === 0n) continue;
        const gap = gapBps(sa, sb);
        v.samples.push(gap);
        if (Math.abs(gap) > v.feeFloorBps) {
          sink.write(
            JSON.stringify({
              ts,
              venue: v.id,
              symbol: v.symbol,
              gapBps: Number(gap.toFixed(4)),
              feeFloorBps: v.feeFloorBps,
              excessBps: Number((Math.abs(gap) - v.feeFloorBps).toFixed(4)),
              poolA: v.a.address,
              poolB: v.b.address,
            }) + "\n",
          );
        }
      }
      rounds++;
    } catch (e) {
      failures++;
      const msg = String(e);
      console.warn(`[survey] round failed (${failures}): ${msg.slice(0, 160)}`);
      if (msg.includes("429")) await new Promise((r) => setTimeout(r, 5000));
    }

    // Progress line every 5 minutes so a long survey is legible while running.
    if (Date.now() - lastProgressAt > 300_000) {
      lastProgressAt = Date.now();
      const live = venues
        .map((v) => report(v, movement))
        .filter((r) => r.clearedCount > 0 && !r.stale)
        .sort((x, y) => y.clearedFraction - x.clearedFraction);
      const mins = Math.round((SURVEY_MINUTES * 60_000 - (deadline - Date.now())) / 60_000);
      console.log(
        `[survey] ${mins}/${SURVEY_MINUTES}min · ${rounds} rounds · ` +
          `${live.length}/${venues.length} venues have EVER cleared their fee floor` +
          (live[0] ? ` · best: ${live[0].symbol} ${live[0].id} ${(live[0].clearedFraction * 100).toFixed(2)}%` : ""),
      );
    }

    const wait = Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - roundStart));
    if (wait > 0 && !stopping) await new Promise((r) => setTimeout(r, wait));
  }

  sink.end();

  const reports = venues
    .map((v) => report(v, movement))
    .filter((r) => r.samples > 0)
    .sort(
      (x, y) => y.clearedFraction - x.clearedFraction || y.bestExcessBps - x.bestExcessBps,
    );

  const cleared = reports.filter((r) => r.clearedCount > 0 && !r.stale);
  const clearedStale = reports.filter((r) => r.clearedCount > 0 && r.stale);

  console.log(
    `\n[survey] DONE — ${rounds} rounds over ${((SURVEY_MINUTES * 60_000 - Math.max(0, deadline - Date.now())) / 60_000).toFixed(1)}min, ` +
      `${failures} failed round(s), ${reports.length} venues with data`,
  );

  console.log(
    `\n=== Venues that EVER cleared their own fee floor (both legs live): ` +
      `${cleared.length}/${reports.length} ===`,
  );
  if (cleared.length === 0) {
    console.log(
      "  NONE. Every surveyed venue's gross price gap stayed inside its round-trip\n" +
        "  pool fee for the whole window — same structural result as ADR-0010, now\n" +
        "  across many pairs rather than one. No shadow run on these venues can be\n" +
        "  profitable, because gross spread never reaches even the loosest bar.",
    );
  } else {
    printTable(cleared, cleared.length);
    console.log(
      "\n  NOTE: clearing the gross-fee bar is necessary, NOT sufficient — it ignores\n" +
        "  tx fee, priority fee, tip, and price impact. These are shadow-run\n" +
        "  candidates, not a go decision.",
    );
  }

  if (clearedStale.length > 0) {
    console.log(
      `\n=== EXCLUDED — cleared the fee floor but a leg never moved: ${clearedStale.length} ===`,
    );
    printTable(clearedStale, clearedStale.length);
    console.log(
      "\n  These look like huge standing arbs and are not. A leg whose sqrtPrice did\n" +
        "  not change once all window is quoting a stale last-trade, not a fillable\n" +
        "  price — the gap cannot be captured at size. Excluded from the verdict.",
    );
  }

  console.log(`\n=== Top 20 venues by observed gap (all surveyed) ===`);
  printTable(
    [...reports].sort((x, y) => y.absGapMax - x.absGapMax),
    20,
  );

  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        surveyedAt: new Date().toISOString(),
        cluster: "mainnet-beta",
        readOnly: true,
        config: { SURVEY_MINUTES, SAMPLE_INTERVAL_MS, MIN_TVL_USD, MAX_VENUES },
        rounds,
        failedRounds: failures,
        venuesCleared: cleared.length,
        venuesClearedButStale: clearedStale.length,
        venuesSurveyed: reports.length,
        reports,
      },
      null,
      2,
    ),
  );
  console.log(`\n[survey] samples above fee floor -> ${samplePath}`);
  console.log(`[survey] full ranked report      -> ${reportPath}`);
}

main().catch((e) => {
  console.error(`[survey] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
