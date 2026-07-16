import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/datasource/rateLimiter.js";

/** Fake clock: sleep() advances time instantly, recording each wait. */
function fakeClock(startMs = 0) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

describe("RateLimiter (token bucket under the Helius 10 req/s ceiling)", () => {
  it("allows a burst up to the per-second budget without waiting", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(8, clock);
    for (let i = 0; i < 8; i++) await rl.acquire();
    expect(clock.sleeps.length).toBe(0);
  });

  it("delays the request that would exceed the budget", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(8, clock);
    for (let i = 0; i < 8; i++) await rl.acquire();
    await rl.acquire(); // ninth within the same instant must wait
    expect(clock.sleeps.length).toBeGreaterThan(0);
    // must have waited roughly one token-refill interval (1000/8 = 125ms)
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(124);
  });

  it("never exceeds the budget in any 1s window across 100 acquisitions", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(8, clock);
    const grantTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      await rl.acquire();
      grantTimes.push(clock.now());
    }
    for (const t of grantTimes) {
      const inWindow = grantTimes.filter((g) => g > t - 1000 && g <= t).length;
      expect(inWindow).toBeLessThanOrEqual(8);
    }
  });

  it("refills over time: after a full second idle, a burst is available again", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(8, clock);
    for (let i = 0; i < 8; i++) await rl.acquire();
    clock.advance(1000);
    const before = clock.sleeps.length;
    for (let i = 0; i < 8; i++) await rl.acquire();
    expect(clock.sleeps.length).toBe(before);
  });

  it("applies exponential backoff after a rate-limit signal, reset on success", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(8, clock, { backoffBaseMs: 500 });
    rl.notifyRateLimited();
    const t0 = clock.now();
    await rl.acquire();
    expect(clock.now() - t0).toBeGreaterThanOrEqual(500);

    rl.notifyRateLimited();
    rl.notifyRateLimited(); // second consecutive -> doubled
    const t1 = clock.now();
    await rl.acquire();
    expect(clock.now() - t1).toBeGreaterThanOrEqual(1000);

    rl.notifySuccess();
    rl.notifyRateLimited(); // back to base after reset
    const t2 = clock.now();
    await rl.acquire();
    const waited = clock.now() - t2;
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(1000 + 125 + 1);
  });

  it("rejects a budget above 10 req/s (Helius free tier)", () => {
    expect(() => new RateLimiter(11, fakeClock())).toThrow(/10/);
  });
});
