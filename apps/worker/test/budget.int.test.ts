import { env } from "@sf/config";
import { closeDb, createBudgetGuard, createUsageLogger } from "@sf/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineJob } from "../src/lib/define-job.js";
import { closeRedis } from "../src/lib/redis.js";
import { type WorkerRuntime, startWorkerRuntime } from "../src/runtime.js";
import {
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  testLogger,
  waitFor,
} from "./helpers.int.js";

/**
 * Both halves of the E0-09 acceptance, against the real runtime.
 *
 * The first: what a job spends is counted against the cap of its provider -
 * asked here through `createBudgetGuard(...).check("gemini")`, which is the
 * one call the budget section of `/system/status` is built from
 * (`apps/api/src/lib/budget.ts`). The seam is that function rather than the
 * route, because a test cannot hold the worker and the api in one process
 * (§6); the other half of the same seam - "what the guard answers reaches the
 * page" - is `apps/api/test/system-status.int.test.ts`. The smoke job of E0-08
 * writes `provider: "system"`, which has no cap and therefore no row in that
 * section, so the acceptance is shown on a provider that has one.
 *
 * The second: spend above the cap stops a job before it makes its call, on the
 * first attempt, and the refusal is readable in `system.dlq`. Against the real
 * runtime because every part of that sentence is something only BullMQ
 * decides: whether an error stops the retries, when the `failed` event fires,
 * and what ends up in `failedReason`.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;

/** Caps of this file only, so that a few cents of fixture exceed them. */
const LIMITS = {
  youtubeUnitsDailySoftCap: 10,
  geminiDailyBudgetUsd: 1,
  ttsMonthlyBudgetUsd: 10,
};

/** Every attempt this job makes is recorded, so "did not retry" is provable. */
const attempts: string[] = [];

const paidJob = defineJob({
  queue: "system.smoke",
  payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
  jobIdFrom: (payload) => `system.smoke/${payload.marker}`,
  handler: async (payload, ctx) => {
    attempts.push(payload.marker);
    // What a paid job does first: ask, then spend. The call below never
    // happens when the guard refuses.
    await ctx.budget.assert("gemini");
    await ctx.usage({
      provider: "gemini",
      operation: "generateContent",
      costUsd: 0.5,
    });
  },
});

const db = openTestDb();
const redis = openTestRedis();
let runtime: WorkerRuntime;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await db.$client`delete from api_usage_log where provider = 'gemini'`;
  await seedQueueSwitches(db);
  runtime = await startWorkerRuntime({
    env,
    db,
    redis,
    log: testLogger(),
    processors: { "system.smoke": paidJob },
    switchIntervalMs: 60_000,
    // The guard of the process, with caps this test can reach; production
    // builds the same object from `env`.
    budget: createBudgetGuard({ db, limits: LIMITS }),
  });
});

afterAll(async () => {
  await runtime.close();
  await obliterateQueues(redis, QUEUES);
  await db.$client`delete from api_usage_log where provider = 'gemini'`;
  await closeDb(db);
  await closeRedis(redis);
});

describe("a job against an exhausted budget", () => {
  it("runs while the cap has room and records what it spent", async () => {
    const marker = `budget-ok-${Date.now()}`;
    // The guard the api asks, built the way the api builds it: no cache, so
    // the answer is the state of the table and not of a key in Redis.
    const guard = createBudgetGuard({ db, limits: LIMITS });
    const before = await guard.check("gemini");

    const jobId = await paidJob.enqueue(runtime.queues.get("system.smoke"), {
      marker,
    });

    const row = await waitFor(
      async () => {
        const rows = await db.$client<{ cost_usd: string }[]>`
          select cost_usd from api_usage_log where job_id = ${jobId}
        `;
        return rows[0];
      },
      { what: `the spend row of ${jobId}` },
    );

    expect(row.cost_usd).toBe("0.50000");

    // The acceptance itself: the row the job wrote is part of what the cap
    // reports, through the same call the spend section of `/system/status`
    // makes. A row that landed outside the window of the aggregate - the
    // clock, the time zone, the transaction - would pass the assertion above
    // and fail this one.
    const after = await guard.check("gemini");
    expect(after?.spent).toBeCloseTo((before?.spent ?? 0) + 0.5, 5);
    expect(after?.scope.key).toBe("gemini_usd_day");
  });

  it("stops the next job before the call, on the first attempt, in the dlq", async () => {
    // The row above is already half the daily cap; this one puts the total on
    // it, and the guard refuses at `spent >= cap`.
    const usage = createUsageLogger(db, { jobId: "fixture/over-cap" });
    await usage({
      provider: "gemini",
      operation: "generateContent",
      costUsd: 0.6,
    });

    const marker = `budget-over-${Date.now()}`;
    const jobId = await paidJob.enqueue(runtime.queues.get("system.smoke"), {
      marker,
    });

    const dlq = runtime.queues.get("system.dlq");
    const record = await waitFor(
      async () => {
        const jobs = await dlq.getJobs(["waiting", "prioritized", "delayed"]);
        return jobs.find((job) => {
          const data: unknown = job.data;
          return (
            typeof data === "object" &&
            data !== null &&
            "jobId" in data &&
            data.jobId === jobId
          );
        });
      },
      { what: `the dlq record of ${jobId}` },
    );

    const data: unknown = record.data;
    const reason =
      typeof data === "object" && data !== null && "failedReason" in data
        ? String(data.failedReason)
        : "";
    // The code and the provider, which is what an operator looking at the DLQ
    // has to be able to tell apart from "the vendor was down".
    expect(reason).toContain("BUDGET_EXCEEDED");
    expect(reason).toContain("gemini");

    // Refused before the call: no spend row of its own, and exactly one
    // attempt - a cap that is retried five times over twenty minutes blocks
    // the queue behind it for nothing.
    const rows = await db.$client<{ id: number }[]>`
      select id from api_usage_log where job_id = ${jobId}
    `;
    expect(rows).toHaveLength(0);
    expect(attempts.filter((seen) => seen === marker)).toHaveLength(1);
  });
});
