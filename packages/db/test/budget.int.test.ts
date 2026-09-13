import { BudgetExceededError } from "@sf/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BudgetLimits, createBudgetGuard } from "../src/budget.js";
import { closeDb } from "../src/client.js";
import { apiUsageLogRepo } from "../src/repos/api-usage-log.js";
import { apiUsageLog } from "../src/schema/system.js";
import { createUsageLogger } from "../src/usage-logger.js";
import { openTestDb, resetTestDatabase } from "./helpers.int.js";

/**
 * The guard against the real table: what a job asks before it spends.
 *
 * The point of doing it here and not only with a stubbed aggregate is the
 * distance between "a row exists" and "the cap fires": the row is written by
 * the logger, summed by Postgres in a window Postgres computes, and compared
 * against a cap in the same measure. Every one of those steps has already been
 * a way to report less spend than there was.
 */
const LIMITS: BudgetLimits = {
  youtubeUnitsDailySoftCap: 100,
  geminiDailyBudgetUsd: 1,
  ttsMonthlyBudgetUsd: 10,
};

const db = openTestDb();
const guard = createBudgetGuard({ db, limits: LIMITS });

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await db.$client`delete from api_usage_log`;
  await closeDb(db);
});

describe("createBudgetGuard against the spend table", () => {
  it("lets a call through while the cap has room", async () => {
    const usage = createUsageLogger(db, { jobId: "radar.snapshot/1" });
    await usage({
      provider: "youtube_data",
      operation: "videos.list",
      units: 50,
    });

    await expect(guard.assert("youtube_data")).resolves.toMatchObject({
      spent: 50,
      cap: 100,
      exceeded: false,
    });
  });

  it("refuses the call once the day's quota cap is reached", async () => {
    const usage = createUsageLogger(db, { jobId: "radar.snapshot/2" });
    await usage({
      provider: "youtube_data",
      operation: "videos.list",
      units: 50,
    });

    const error = await guard
      .assert("youtube_data")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).details).toEqual({
      provider: "youtube_data",
      spent: 100,
      cap: 100,
    });
  });

  /**
   * The monthly TTS budget is one cap over four vendors: spread across them,
   * a per-provider aggregate would show a quarter of the spend and the cap
   * would never fire.
   */
  it("adds up the paid speech vendors against the single monthly cap", async () => {
    const usage = createUsageLogger(db, { jobId: "tts.generate/1" });
    await usage({
      provider: "elevenlabs",
      operation: "tts.synthesize",
      costUsd: 4,
    });
    await usage({
      provider: "openai_tts",
      operation: "tts.synthesize",
      costUsd: 3.5,
    });

    await expect(guard.check("cartesia")).resolves.toMatchObject({
      spent: 7.5,
      cap: 10,
      warn: false,
    });

    await usage({
      provider: "google_tts",
      operation: "tts.synthesize",
      costUsd: 2.5,
    });

    const error = await guard.assert("cartesia").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).details).toMatchObject({
      provider: "cartesia",
      spent: 10,
    });
  });

  /**
   * Cheap calls are the ones a rounding to the nearest would drop, and they
   * are also how a fan-out reaches a cap: a hundred of them at $0.000004 have
   * to be visible to the guard as spend, not as nothing.
   */
  it("counts spend too small for the column to hold exactly", async () => {
    await db.$client`delete from api_usage_log`;
    const usage = createUsageLogger(db, { jobId: "gemini.price/1" });
    for (let i = 0; i < 100; i++) {
      await usage({
        provider: "gemini",
        operation: "generateContent",
        costUsd: 0.000004,
      });
    }

    await expect(guard.check("gemini")).resolves.toMatchObject({
      spent: 0.001,
    });
  });
});

/**
 * Whose day the quota counter is counting.
 *
 * Google resets the YouTube Data quota at midnight Pacific. Between 00:00 UTC
 * and 00:00 PT - the seven hours after 17:00 PT - a counter cut in UTC has
 * already restarted while Google's has not, so the fuse would clear another
 * full day of units against a quota that is nearly spent. The money caps are
 * ours and roll over in UTC; both are properties of the cap, and this is what
 * says so against a real `date_trunc`.
 */
describe("the day a cap is counted in", () => {
  /** 19:00 on 13 March Pacific, already the 14th in UTC. */
  const NOW = new Date("2026-03-14T02:00:00Z");
  /** 16:00 Pacific on the same Pacific day, still the 13th in UTC. */
  const BEFORE_MIDNIGHT_UTC = new Date("2026-03-13T23:00:00Z");

  it("keeps the units of the Pacific day the UTC day has already dropped", async () => {
    await db.$client`delete from api_usage_log`;
    await db.insert(apiUsageLog).values({
      provider: "youtube_data",
      operation: "videos.list",
      units: 60,
      createdAt: BEFORE_MIDNIGHT_UTC,
    });

    const pacific = createBudgetGuard({
      db,
      limits: LIMITS,
      now: () => NOW,
    });

    // The scope of the quota carries `America/Los_Angeles`, so the row is
    // still part of today and 60 of the 100 units are gone.
    await expect(pacific.check("youtube_data")).resolves.toMatchObject({
      spent: 60,
      cap: 100,
      exceeded: false,
    });

    // The same rows in UTC: the day turned over two hours ago and the counter
    // reads empty - the answer that hands out a second quota.
    await expect(
      apiUsageLogRepo.sumUsage(
        db,
        { providers: ["youtube_data"], measure: "units", period: "day" },
        { now: NOW, timeZone: "UTC" },
      ),
    ).resolves.toBe(0);
  });

  it("counts the money caps in UTC", async () => {
    await db.$client`delete from api_usage_log`;
    await db.insert(apiUsageLog).values({
      provider: "gemini",
      operation: "generateContent",
      costUsd: "0.40000",
      createdAt: BEFORE_MIDNIGHT_UTC,
    });

    const guard = createBudgetGuard({ db, limits: LIMITS, now: () => NOW });

    // Our own day, which turned over at 00:00 UTC: yesterday's spend is not
    // today's.
    await expect(guard.check("gemini")).resolves.toMatchObject({ spent: 0 });
  });
});
