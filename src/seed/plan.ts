/**
 * Pure planning logic for the devnet pool-seeding script
 * (scripts/seed-devnet-pools.ts). No SDK, no I/O — just the deposit-amount
 * math, price-gap derivation, and safety guards, so the parts that decide
 * how much real devnet money to spend are unit-tested before anything runs.
 */

/** Exact rational (quote-raw per base-raw); avoids float in money math. */
export interface Rational {
  num: bigint;
  den: bigint;
}

export interface SeedPlanParams {
  cluster: string;
  /** Base-token (WSOL) raw amount deposited into EACH pool's base side. */
  baseDepositRaw: bigint;
  /** Target mid price, quote-raw per base-raw. */
  midPrice: Rational;
  /** Raydium base price is set this many bps BELOW mid (buy base there). */
  gapBps: number;
  /** Each pool's quote deposit must be at least this (non-dust floor). */
  minQuoteDepositRaw: bigint;
  /** Wallet balances available to spend. */
  available: { baseRaw: bigint; quoteRaw: bigint };
  /**
   * Pools already created in a prior (possibly interrupted) run. Their
   * deposits are already spent, so the balance guard excludes them — only
   * the remaining pools' deposits must be covered.
   */
  alreadySeeded?: { raydium?: boolean; orca?: boolean };
}

export interface PoolDeposit {
  baseRaw: bigint;
  quoteRaw: bigint;
}

export interface SeedPlan {
  raydium: PoolDeposit;
  orca: PoolDeposit;
  totalBaseRaw: bigint;
  totalQuoteRaw: bigint;
  /** Realized raydium-vs-orca price gap, bps (negative = base cheaper on raydium). */
  expectedGapBps: number;
}

const BPS = 10_000n;

export function buildSeedPlan(p: SeedPlanParams): SeedPlan {
  assertDevnet(p.cluster);

  // Orca sits at mid; raydium gapBps below mid so base (WSOL) is cheaper
  // there and the bot buys on raydium, sells on orca.
  const orcaQuoteRaw = quoteForBase(p.baseDepositRaw, p.midPrice, BPS);
  const raydiumQuoteRaw = quoteForBase(
    p.baseDepositRaw,
    p.midPrice,
    BPS - BigInt(p.gapBps),
  );

  const raydium: PoolDeposit = {
    baseRaw: p.baseDepositRaw,
    quoteRaw: raydiumQuoteRaw,
  };
  const orca: PoolDeposit = { baseRaw: p.baseDepositRaw, quoteRaw: orcaQuoteRaw };

  assertNonDust(raydium.quoteRaw, p.minQuoteDepositRaw, "raydium");
  assertNonDust(orca.quoteRaw, p.minQuoteDepositRaw, "orca");

  const totalBaseRaw = raydium.baseRaw + orca.baseRaw;
  const totalQuoteRaw = raydium.quoteRaw + orca.quoteRaw;

  // Only pools not already seeded still need to be funded.
  const needRaydium = !p.alreadySeeded?.raydium;
  const needOrca = !p.alreadySeeded?.orca;
  const needBaseRaw =
    (needRaydium ? raydium.baseRaw : 0n) + (needOrca ? orca.baseRaw : 0n);
  const needQuoteRaw =
    (needRaydium ? raydium.quoteRaw : 0n) + (needOrca ? orca.quoteRaw : 0n);
  assertSufficient(needBaseRaw, p.available.baseRaw, "base (WSOL)");
  assertSufficient(needQuoteRaw, p.available.quoteRaw, "quote (devUSDC)");

  return {
    raydium,
    orca,
    totalBaseRaw,
    totalQuoteRaw,
    expectedGapBps: gapBps(raydium, orca),
  };
}

/** raydium price relative to orca, bps (matches detect.ts convention). */
function gapBps(raydium: PoolDeposit, orca: PoolDeposit): number {
  const num = raydium.quoteRaw * orca.baseRaw * BPS;
  const den = raydium.baseRaw * orca.quoteRaw;
  return Number(num / den) - 10_000;
}

function assertNonDust(quoteRaw: bigint, floor: bigint, pool: string): void {
  if (quoteRaw < floor) {
    throw new Error(
      `Refusing to seed ${pool}: quote deposit ${quoteRaw} is below the ` +
        `non-dust floor ${floor}. Raise baseDepositRaw or the target price.`,
    );
  }
}

function assertSufficient(need: bigint, have: bigint, label: string): void {
  if (need > have) {
    throw new Error(
      `Insufficient ${label}: plan needs ${need} but wallet has ${have} ` +
        `(short by ${need - have}).`,
    );
  }
}

/** quote = base * price * (priceScale/BPS), exact integer (floored) math. */
function quoteForBase(
  baseRaw: bigint,
  price: Rational,
  priceScaleBps: bigint,
): bigint {
  return (baseRaw * price.num * priceScaleBps) / (price.den * BPS);
}

/** NEVER_DO #1: seeding must never touch mainnet. */
function assertDevnet(cluster: string): void {
  if (cluster.includes("mainnet")) {
    throw new Error(
      `Refusing to seed pools: cluster "${cluster}" is mainnet. ` +
        "Seeding is devnet-only (docs/NEVER_DO.md).",
    );
  }
}
