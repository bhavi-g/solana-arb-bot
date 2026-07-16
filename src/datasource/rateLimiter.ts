/**
 * Sliding-window rate limiter enforcing the client-side request ceiling
 * (Helius free tier: 10 req/s — ADR-0002). Every RPC call in the polling
 * data source must pass through acquire(). Exponential backoff kicks in
 * when the provider signals rate limiting (HTTP 429 / JSON-RPC -32429).
 *
 * The clock is injectable so tests run deterministically without timers.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RateLimiterOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const HELIUS_FREE_TIER_RPS = 10;

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  /** Grant timestamps within the last second (strict sliding window). */
  private grants: number[] = [];
  private consecutiveRateLimits = 0;
  private backoffUntilMs = 0;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    private readonly maxPerSecond: number,
    private readonly clock: Clock = realClock,
    opts: RateLimiterOptions = {},
  ) {
    if (maxPerSecond <= 0 || maxPerSecond > HELIUS_FREE_TIER_RPS) {
      throw new RangeError(
        `maxPerSecond must be in (0, ${HELIUS_FREE_TIER_RPS}]`,
      );
    }
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
  }

  /**
   * Resolves when it is safe to issue one request. Sliding-window rather
   * than token-bucket: no burst+refill combination can ever place more
   * than maxPerSecond grants inside any trailing 1s window.
   */
  async acquire(): Promise<void> {
    // Honor any active backoff penalty first.
    const backoffWait = this.backoffUntilMs - this.clock.now();
    if (backoffWait > 0) {
      await this.clock.sleep(backoffWait);
    }

    for (;;) {
      const now = this.clock.now();
      this.grants = this.grants.filter((t) => t > now - 1000);
      if (this.grants.length < this.maxPerSecond) {
        this.grants.push(now);
        return;
      }
      const oldest = this.grants[0]!;
      await this.clock.sleep(oldest + 1000 - now);
    }
  }

  /** Call when the provider returned 429 / -32429. */
  notifyRateLimited(): void {
    this.consecutiveRateLimits += 1;
    const penalty = Math.min(
      this.backoffBaseMs * 2 ** (this.consecutiveRateLimits - 1),
      this.backoffMaxMs,
    );
    this.backoffUntilMs = this.clock.now() + penalty;
  }

  /** Call after a successful request to reset the backoff ladder. */
  notifySuccess(): void {
    this.consecutiveRateLimits = 0;
    this.backoffUntilMs = 0;
  }
}
