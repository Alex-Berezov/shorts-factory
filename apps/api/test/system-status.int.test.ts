import { env, limits } from "@sf/config";
import { SystemStatusResponseSchema } from "@sf/contracts";
import {
  QUEUE_NAMES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SEC,
} from "@sf/core";
import { closeDb, createDb, createUsageLogger } from "@sf/db";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppInstance, buildApp } from "../src/app.js";
import { createBudgetProbe } from "../src/lib/budget.js";
import { createHealthProbes } from "../src/lib/health.js";
import { createWorkerProbe } from "../src/lib/heartbeat.js";
import { type QueueStats, createQueueStats } from "../src/lib/queue-stats.js";
import { closeRedis } from "../src/lib/redis.js";
import { openTestRedis } from "./helpers.int.js";
import { AUTH_HEADER, TEST_PASSWORD } from "./helpers.js";

/**
 * The first half of the E0-09 acceptance, against the stack of
 * `infra/docker-compose.yml`: a row written into `api_usage_log` is visible in
 * `/system/status`, and the queue counters and the heartbeat are the real ones.
 *
 * The two suites run at the same time (`turbo run test:int`), so this one
 * keeps to a Redis database of its own (`local-stack-guard.ts`) and to a
 * provider of its own in the shared test database: the worker spends `gemini`,
 * this file spends `youtube_data`, and everything it writes it also removes.
 */
const JOB_ID = "api-system-status-int";
const PROBE_QUEUE = "system.smoke";
/** A queue nothing in this file opens directly - it must stay untouched. */
const UNTOUCHED_QUEUE = "radar.sync-channels";
/**
 * The queue this file pauses - one the cases above do not read a counter of,
 * so that a pause and a resume of it cannot explain any other assertion here.
 */
const PAUSE_QUEUE = "radar.snapshot";
/** Units of the fixture call, large enough to be visible against any total. */
const SPENT_UNITS = 37;

const db = createDb(env.DATABASE_URL, { max: 2 });
const redis = openTestRedis();
let queueStats: QueueStats;
let app: AppInstance;

async function clean(): Promise<void> {
  // By job id, never by provider: the worker suite is running against the same
  // table, and a delete by provider would take rows it is counting.
  await db.$client`delete from api_usage_log where job_id = ${JOB_ID}`;
  await redis.del(WORKER_HEARTBEAT_KEY, `bull:${UNTOUCHED_QUEUE}:meta`);
}

beforeAll(async () => {
  await clean();
  queueStats = createQueueStats({ connection: redis });
  app = buildApp(
    {
      health: createHealthProbes({ db, redis }),
      buildInfo: { version: "int", commit: "int" },
      queues: queueStats,
      worker: createWorkerProbe({ redis }),
      budget: createBudgetProbe({ db, limits }),
    },
    { adminPassword: TEST_PASSWORD, logger: false },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await queueStats.close();
  await clean();
  await closeDb(db);
  await closeRedis(redis);
});

/** The page, parsed against the contract rather than read as free JSON. */
async function readStatus() {
  const res = await app.inject({
    method: "GET",
    url: "/system/status",
    headers: { authorization: AUTH_HEADER },
  });
  expect(res.statusCode).toBe(200);
  return SystemStatusResponseSchema.parse(JSON.parse(res.payload));
}

describe("GET /system/status against the live stack", () => {
  it("shows a spend row the moment it is written", async () => {
    const before = await readStatus();
    const quota = before.budget?.find(
      (row) => row.key === "youtube_data_units_day",
    );
    expect(quota).toBeDefined();

    // Written the way a job writes it - through the logger, not through SQL.
    await createUsageLogger(db, { jobId: JOB_ID })({
      provider: "youtube_data",
      operation: "videos.list",
      units: SPENT_UNITS,
    });

    const after = await readStatus();
    const spent = after.budget?.find(
      (row) => row.key === "youtube_data_units_day",
    )?.spent;

    // No cache in front of this section on purpose: the answer is the state of
    // the table now, not the state it was in a minute ago.
    expect(spent).toBe((quota?.spent ?? 0) + SPENT_UNITS);
  });

  it("reports every cap of the guard with its limit from the configuration", async () => {
    const body = await readStatus();

    expect(body.budget?.map((row) => row.key)).toEqual([
      "youtube_data_units_day",
      "gemini_usd_day",
      "tts_usd_month",
    ]);
    expect(body.budget?.[0]).toMatchObject({
      measure: "units",
      period: "day",
      // The quota day is Google's, and the page says whose day it is.
      timeZone: "America/Los_Angeles",
      cap: limits.youtubeUnitsDailySoftCap,
    });
  });

  it("reports every queue of the registry, and the depth of the dlq", async () => {
    const body = await readStatus();

    expect(body.queues).not.toBeNull();
    expect(body.queues?.length).toBe(QUEUE_NAMES.length);
    const smoke = body.queues?.find((queue) => queue.name === PROBE_QUEUE);
    expect(smoke).toMatchObject({ paused: false });
    // The dlq row and the section are the same reading of the same queue.
    const dlq = body.queues?.find((queue) => queue.name === "system.dlq");
    expect(body.dlq?.size).toBe(dlq?.waiting);
  });

  /**
   * A paused queue is the case the counters alone get wrong: BullMQ renames
   * the `wait` list to `paused`, so the queue would read as empty and idle -
   * "nothing to do" instead of "nobody is taking it".
   */
  it("tells a paused queue from an idle one", async () => {
    const queue = new Queue(PAUSE_QUEUE, { connection: redis });
    try {
      await queue.pause();

      const body = await readStatus();
      expect(
        body.queues?.find((entry) => entry.name === PAUSE_QUEUE),
      ).toMatchObject({ paused: true });

      // And on that queue only: the flag is read per queue, so a page that
      // reported the pause for the whole registry would be as wrong as one
      // that missed it. That the pause cannot reach the queues of the worker
      // suite is a property of the namespace this file runs in, and it is
      // asserted where it is decided - `local-stack-guard.test.ts` - rather
      // than by reading the Redis database that suite owns.
      expect(
        body.queues?.find((entry) => entry.name === PROBE_QUEUE),
      ).toMatchObject({ paused: false });
    } finally {
      await queue.resume();
      await queue.close();
    }
  });

  /**
   * The page is a reader. A `Queue` opened without `skipMetasUpdate` writes
   * `bull:<name>:meta` on its way to ready, so opening `/system/status` would
   * create the meta of every queue nobody has run yet and overwrite the event
   * stream bound the worker set (ADR-0003: the api does not change queues).
   */
  it("creates nothing in Redis for a queue it only read", async () => {
    await redis.del(`bull:${UNTOUCHED_QUEUE}:meta`);

    // A reader of its own: the write happens in the constructor of a `Queue`,
    // and the queues of the running app were built before this key was removed.
    const reader = createQueueStats({ connection: redis });
    try {
      await reader.collect();
    } finally {
      await reader.close();
    }

    expect(await redis.exists(`bull:${UNTOUCHED_QUEUE}:meta`)).toBe(0);
  });

  it("reads the heartbeat the worker leaves, and its absence", async () => {
    const missing = await readStatus();
    expect(missing.worker).toEqual({ heartbeatAt: null, stale: true });

    const stamp = new Date().toISOString();
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      stamp,
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );

    const live = await readStatus();
    expect(live.worker).toEqual({ heartbeatAt: stamp, stale: false });
    expect(live.checks).toEqual({
      db: { status: "up", reason: null },
      redis: { status: "up", reason: null },
    });
  });
});
