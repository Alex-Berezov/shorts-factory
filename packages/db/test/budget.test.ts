import {
  BUDGET_CACHE_TTL_SEC,
  BudgetExceededError,
  ValidationError,
  budgetCacheKey,
} from "@sf/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type BudgetCache,
  type BudgetLimits,
  createBudgetGuard,
} from "../src/budget.js";
import { closeDb, createDb } from "../src/client.js";
import { apiUsageLogRepo } from "../src/repos/api-usage-log.js";

const LIMITS: BudgetLimits = {
  youtubeUnitsDailySoftCap: 8_000,
  geminiDailyBudgetUsd: 5,
  ttsMonthlyBudgetUsd: 50,
};

/**
 * A real handle that is never queried: every total in this file comes from the
 * stub on `apiUsageLogRepo.sumUsage` below, so no statement ever reaches the
 * socket (the driver connects on the first query, not on construction).
 */
const db = createDb("postgres://sf:sf@127.0.0.1:5442/unused", { max: 1 });

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDb(db);
});

/** The aggregate, answering a fixed total; the calls are the assertion. */
function spendsInTheDatabase(...totals: number[]) {
  const stub = vi.spyOn(apiUsageLogRepo, "sumUsage");
  for (const total of totals) {
    stub.mockResolvedValueOnce(total);
  }
  return stub;
}

/** A cache with a memory, which also records what it was asked for. */
function fakeCache(): {
  cache: BudgetCache;
  entries: Map<string, { value: string; ttlSec: number }>;
  reads: string[];
} {
  const entries = new Map<string, { value: string; ttlSec: number }>();
  const reads: string[] = [];
  return {
    entries,
    reads,
    cache: {
      async get(key: string): Promise<string | null> {
        reads.push(key);
        return entries.get(key)?.value ?? null;
      },
      async set(key: string, value: string, ttlSec: number): Promise<void> {
        entries.set(key, { value, ttlSec });
      },
    },
  };
}

function recordingLog() {
  return { warn: vi.fn<(obj: object, msg: string) => void>() };
}

describe("budget guard thresholds", () => {
  it("reports the scope, the total and where it stands", async () => {
    const sum = spendsInTheDatabase(4_000);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    const check = await guard.check("youtube_data");

    expect(check).toMatchObject({
      spent: 4_000,
      cap: 8_000,
      ratio: 0.5,
      warn: false,
      exceeded: false,
    });
    expect(check?.scope).toMatchObject({
      key: "youtube_data_units_day",
      measure: "units",
      period: "day",
    });
    // The scope travels into the aggregate whole: the guard never re-derives
    // which rows and which window a cap covers.
    expect(sum).toHaveBeenCalledTimes(1);
    expect(sum).toHaveBeenCalledWith(db, check?.scope, {
      timeZone: "America/Los_Angeles",
    });
  });

  it("warns from four fifths of a cap on", async () => {
    spendsInTheDatabase(3.99, 4);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    expect(await guard.check("gemini")).toMatchObject({ warn: false });
    expect(await guard.check("gemini")).toMatchObject({
      warn: true,
      exceeded: false,
    });
  });

  it("treats sitting exactly on the cap as exceeded", async () => {
    // The guard is asked before the call, so a budget that is precisely spent
    // must stop the next one rather than allow one more.
    spendsInTheDatabase(5);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    expect(await guard.check("gemini")).toMatchObject({ exceeded: true });
  });

  it("sums the paid speech vendors against the one monthly cap", async () => {
    const sum = spendsInTheDatabase(12);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    const check = await guard.check("openai_tts");

    expect(check?.cap).toBe(50);
    expect(check?.scope.providers).toEqual([
      "elevenlabs",
      "openai_tts",
      "google_tts",
      "cartesia",
    ]);
    expect(sum).toHaveBeenCalledTimes(1);
  });

  /**
   * The zone is a property of the cap, not of whoever asks: the YouTube quota
   * resets at midnight Pacific and the money budgets in UTC, so one zone held
   * by the guard would have to be wrong for one of them - and wrong for the
   * quota means a counter that restarts seven hours before Google's does.
   */
  it("counts each cap in the zone of its own scope", async () => {
    const sum = spendsInTheDatabase(0, 0, 0);
    const now = new Date("2026-03-15T20:00:00Z");
    const guard = createBudgetGuard({ db, limits: LIMITS, now: () => now });

    await guard.check("youtube_data");
    await guard.check("gemini");
    await guard.check("openai_tts");

    expect(sum).toHaveBeenCalledTimes(3);
    expect(sum).toHaveBeenNthCalledWith(1, db, expect.anything(), {
      timeZone: "America/Los_Angeles",
      now,
    });
    expect(sum).toHaveBeenNthCalledWith(2, db, expect.anything(), {
      timeZone: "UTC",
      now,
    });
    expect(sum).toHaveBeenNthCalledWith(3, db, expect.anything(), {
      timeZone: "UTC",
      now,
    });
  });
});

describe("budget guard without a cap", () => {
  it("answers null for a provider that has none yet", async () => {
    const sum = spendsInTheDatabase();
    const guard = createBudgetGuard({ db, limits: LIMITS });

    expect(await guard.check("youtube_analytics")).toBeNull();
    expect(await guard.check("system")).toBeNull();
    expect(sum).toHaveBeenCalledTimes(0);
  });

  it("refuses to be asserted against, instead of clearing the call", async () => {
    // A fuse that was never installed cannot clear anything: answering "fine"
    // here would make every uncapped provider look guarded.
    const guard = createBudgetGuard({ db, limits: LIMITS });

    await expect(guard.assert("youtube_analytics")).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("budget guard assert", () => {
  it("lets a call through below the cap and reports where it stands", async () => {
    spendsInTheDatabase(1.25);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    await expect(guard.assert("gemini")).resolves.toMatchObject({
      spent: 1.25,
      cap: 5,
      exceeded: false,
    });
  });

  it("refuses the call past the cap, naming the provider and the numbers", async () => {
    spendsInTheDatabase(7.5);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    const error = await guard.assert("gemini").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).details).toEqual({
      provider: "gemini",
      spent: 7.5,
      cap: 5,
    });
  });
});

describe("budget guard cache", () => {
  it("reuses a total for the next check and stores it under the shared key", async () => {
    const sum = spendsInTheDatabase(1);
    const { cache, entries } = fakeCache();
    const guard = createBudgetGuard({ db, limits: LIMITS, cache });

    expect(await guard.check("gemini")).toMatchObject({ spent: 1 });
    expect(await guard.check("gemini")).toMatchObject({ spent: 1 });

    expect(sum).toHaveBeenCalledTimes(1);
    const entry = entries.get(budgetCacheKey("gemini_usd_day"));
    expect(entry?.ttlSec).toBe(BUDGET_CACHE_TTL_SEC);
    expect(JSON.parse(entry?.value ?? "null")).toEqual({
      spent: 1,
      warn: false,
    });
  });

  it("counts again once the stored total was already warning", async () => {
    // A minute-old total near the cap is exactly what lets a fan-out of paid
    // jobs spend past it, so from the warning share on the cache is bypassed.
    const sum = spendsInTheDatabase(4, 4.5);
    const { cache } = fakeCache();
    const guard = createBudgetGuard({ db, limits: LIMITS, cache });

    expect(await guard.check("gemini")).toMatchObject({ spent: 4 });
    expect(await guard.check("gemini")).toMatchObject({ spent: 4.5 });

    expect(sum).toHaveBeenCalledTimes(2);
  });

  it("refuses a call past the cap even while a comfortable total is cached", async () => {
    const sum = spendsInTheDatabase(4, 6);
    const { cache, entries } = fakeCache();
    const guard = createBudgetGuard({ db, limits: LIMITS, cache });

    await guard.check("gemini");
    // Written by an older guard, or by a run a minute ago: below the warning
    // share, so the next check would be allowed to reuse it - but the stored
    // state has to be re-judged against the cap in force now.
    entries.set(budgetCacheKey("gemini_usd_day"), {
      value: JSON.stringify({ spent: 4, warn: false }),
      ttlSec: BUDGET_CACHE_TTL_SEC,
    });
    const lowered = createBudgetGuard({
      db,
      limits: { ...LIMITS, geminiDailyBudgetUsd: 4 },
      cache,
    });

    await expect(lowered.assert("gemini")).rejects.toThrow(BudgetExceededError);
    expect(sum).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable value as a miss and says so", async () => {
    const sum = spendsInTheDatabase(2);
    const { cache, entries } = fakeCache();
    const log = recordingLog();
    entries.set(budgetCacheKey("gemini_usd_day"), {
      value: "{not json",
      ttlSec: BUDGET_CACHE_TTL_SEC,
    });
    const guard = createBudgetGuard({ db, limits: LIMITS, cache, log });

    expect(await guard.check("gemini")).toMatchObject({ spent: 2 });
    expect(sum).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("treats a value of the wrong shape as a miss", async () => {
    const sum = spendsInTheDatabase(2);
    const { cache, entries } = fakeCache();
    entries.set(budgetCacheKey("gemini_usd_day"), {
      value: JSON.stringify({ spent: "plenty" }),
      ttlSec: BUDGET_CACHE_TTL_SEC,
    });
    const guard = createBudgetGuard({ db, limits: LIMITS, cache });

    expect(await guard.check("gemini")).toMatchObject({ spent: 2 });
    expect(sum).toHaveBeenCalledTimes(1);
  });

  it("keeps answering when the cache itself fails", async () => {
    // Redis being down must not stop the pipeline: the total is counted from
    // the database and the failure is a log line, not a refusal.
    const sum = spendsInTheDatabase(2, 3);
    const log = recordingLog();
    const broken: BudgetCache = {
      async get(): Promise<string | null> {
        throw new Error("Stream isn't writeable");
      },
      async set(): Promise<void> {
        throw new Error("Stream isn't writeable");
      },
    };
    const guard = createBudgetGuard({ db, limits: LIMITS, cache: broken, log });

    expect(await guard.check("gemini")).toMatchObject({ spent: 2 });
    expect(await guard.check("gemini")).toMatchObject({ spent: 3 });

    expect(sum).toHaveBeenCalledTimes(2);
    // One for the failed read, one for the failed write, per check.
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it("does not touch a cache it was not given", async () => {
    const sum = spendsInTheDatabase(1, 1);
    const guard = createBudgetGuard({ db, limits: LIMITS });

    await guard.check("gemini");
    await guard.check("gemini");

    // The api builds its guard this way on purpose: a row written a second ago
    // has to be visible on `/system/status` now.
    expect(sum).toHaveBeenCalledTimes(2);
  });
});
