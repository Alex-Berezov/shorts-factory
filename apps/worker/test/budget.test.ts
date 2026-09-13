import { BUDGET_CACHE_TTL_SEC, budgetCacheKey } from "@sf/core";
import { apiUsageLogRepo, createBudgetGuard, createDb } from "@sf/db";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import {
  BudgetCacheTimeoutError,
  createRedisBudgetCache,
} from "../src/lib/budget.js";

/**
 * The adapter is four lines, and all four are the contract between the guard
 * in `@sf/db` - which may not know about ioredis - and Redis. A `set` without
 * an expiry is the failure worth a test of its own: a total that never expires
 * is a cap that is checked once and then believed forever.
 */
function lazyRedis(): Redis {
  return new Redis({ lazyConnect: true });
}

describe("createRedisBudgetCache", () => {
  it("writes the total with the shared expiry", async () => {
    const redis = lazyRedis();
    const set = vi.spyOn(redis, "set").mockResolvedValue("OK");

    await createRedisBudgetCache(redis).set(
      budgetCacheKey("gemini_usd_day"),
      '{"spent":1,"warn":false}',
      BUDGET_CACHE_TTL_SEC,
    );

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      "budget:gemini_usd_day",
      '{"spent":1,"warn":false}',
      "EX",
      BUDGET_CACHE_TTL_SEC,
    );
    redis.disconnect();
  });

  it("reads a key that was never written as a miss", async () => {
    const redis = lazyRedis();
    vi.spyOn(redis, "get").mockResolvedValue(null);

    await expect(
      createRedisBudgetCache(redis).get(budgetCacheKey("tts_usd_month")),
    ).resolves.toBeNull();
    redis.disconnect();
  });

  it("lets a failure of the connection through to the guard", async () => {
    // Not swallowed here: what a cache that is down means - count from the
    // database and log it - is the guard's decision, not the adapter's.
    const redis = lazyRedis();
    vi.spyOn(redis, "get").mockRejectedValue(new Error("Connection is closed"));

    await expect(
      createRedisBudgetCache(redis).get(budgetCacheKey("gemini_usd_day")),
    ).rejects.toThrow(/Connection is closed/);
    redis.disconnect();
  });
});

/**
 * The failure the adapter exists for, and the one a mock that rejects cannot
 * show: this process talks to Redis through the BullMQ client, where
 * `maxRetriesPerRequest: null` and the offline queue mean that a command sent
 * to a Redis that is down is neither answered nor refused - it waits. The
 * guard's fallback ("count from the database, log it") only ever sees
 * rejections, so without a deadline of its own the fallback is unreachable and
 * a paid job hangs on its own fuse for the length of the outage.
 */
describe("a cache command that never comes back", () => {
  /** A client that accepts the command and then says nothing, like a dead socket. */
  function hangingRedis(): Redis {
    const redis = new Redis({ lazyConnect: true });
    vi.spyOn(redis, "get").mockReturnValue(new Promise(() => {}));
    vi.spyOn(redis, "set").mockReturnValue(new Promise(() => {}));
    return redis;
  }

  it("gives up on its own instead of waiting for the socket", async () => {
    const redis = hangingRedis();
    const cache = createRedisBudgetCache(redis, { timeoutMs: 20 });

    await expect(
      cache.get(budgetCacheKey("gemini_usd_day")),
    ).rejects.toBeInstanceOf(BudgetCacheTimeoutError);
    await expect(
      cache.set(budgetCacheKey("gemini_usd_day"), "{}", BUDGET_CACHE_TTL_SEC),
    ).rejects.toBeInstanceOf(BudgetCacheTimeoutError);

    redis.disconnect();
  });

  it("leaves the guard free to answer from the database and say so", async () => {
    const redis = hangingRedis();
    // Never queried: the aggregate is stubbed, so nothing reaches the socket.
    const db = createDb("postgres://sf:sf@127.0.0.1:5442/unused", { max: 1 });
    const sums = vi.spyOn(apiUsageLogRepo, "sumUsage").mockResolvedValue(2);
    const log = { warn: vi.fn<(obj: object, msg: string) => void>() };

    const guard = createBudgetGuard({
      db,
      limits: {
        youtubeUnitsDailySoftCap: 10,
        geminiDailyBudgetUsd: 5,
        ttsMonthlyBudgetUsd: 50,
      },
      cache: createRedisBudgetCache(redis, { timeoutMs: 20 }),
      log,
    });

    await expect(guard.assert("gemini")).resolves.toMatchObject({ spent: 2 });
    expect(sums).toHaveBeenCalledTimes(1);
    // One line for the read that timed out, one for the write that did.
    expect(log.warn).toHaveBeenCalledTimes(2);

    await db.$client.end();
    redis.disconnect();
    vi.restoreAllMocks();
  });
});
