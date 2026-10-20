import { setTimeout as sleep } from "node:timers/promises";
import { limits } from "@sf/config";
import { SystemStatusResponseSchema } from "@sf/contracts";
import {
  QUEUE_NAMES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SEC,
} from "@sf/core";
import { type Db, type ProbeDb, closeDb, createUsageLogger } from "@sf/db";
import { openRelay } from "@sf/db/test-support/relay";
import { TEST_REDIS_DATABASE_OF } from "@sf/db/test-support/stack-guard";
import { closeRedis } from "@sf/runtime";
import {
  recordingLogger,
  silentLogger,
} from "@sf/runtime/test-support/recording-logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppInstance, buildApp } from "../src/app.js";
import { createBudgetProbe } from "../src/lib/budget.js";
import { PROBE_QUERY_LIMIT_MS } from "../src/lib/dependency-timeout.js";
import { createHealthProbes } from "../src/lib/health.js";
import { createWorkerProbe } from "../src/lib/heartbeat.js";
import { openProbeDbs } from "../src/lib/probe-dbs.js";
import { type QueueStats, createQueueStats } from "../src/lib/queue-stats.js";
import {
  openTestDb,
  openTestProbeDb,
  openTestQueues,
  openTestRedis,
  whenReady,
} from "./helpers.int.js";
import {
  AUTH_HEADER,
  EMPTY_QUEUES,
  LIVE_WORKER,
  TEST_PASSWORD,
} from "./helpers.js";

/**
 * The first half of the E0-09 acceptance, against the stack of
 * `infra/docker-compose.yml`: a row written into `api_usage_log` is visible in
 * `/system/status`, and the queue counters and the heartbeat are the real ones.
 *
 * The api and the worker suites share one test stack, one after the other
 * (`turbo run test:int --concurrency=1`), and whatever a crashed run leaves
 * behind is met by the next one, so this suite keeps to a Redis database of its
 * own (`suiteRedisUrl` of `packages/db/test-support/stack-guard.ts`, through
 * `openTestRedis` in `helpers.int.ts`) and to a provider of its own in the
 * shared test database: the worker spends `gemini`, this file spends
 * `youtube_data`, and everything it writes it also removes.
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

const db = openTestDb();
// The handles the page reads through, as `compose-app.ts` opens them: the
// fixture above writes and cleans, these only read.
const healthDb = openTestProbeDb();
const budgetDb = openTestProbeDb();
const redis = openTestRedis();
let queueStats: QueueStats;
let app: AppInstance;

async function clean(): Promise<void> {
  // By job id, never by provider: the suites share the table (only their Redis
  // databases differ), and a delete by provider would take rows of another
  // suite, left by a crashed run or counted by a case of its own.
  await db.$client`delete from api_usage_log where job_id = ${JOB_ID}`;
  await redis.del(WORKER_HEARTBEAT_KEY, `bull:${UNTOUCHED_QUEUE}:meta`);
}

beforeAll(async () => {
  await clean();
  queueStats = createQueueStats({ connection: redis, log: silentLogger() });
  app = buildApp(
    {
      health: createHealthProbes({ db: healthDb, redis }),
      buildInfo: { version: "int", commit: "int" },
      queues: queueStats,
      worker: createWorkerProbe({ redis }),
      budget: createBudgetProbe({ db: budgetDb, limits }),
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
  await healthDb.close({ timeoutSec: 1 });
  await budgetDb.close({ timeoutSec: 1 });
  await closeRedis(redis);
});

/** The page, parsed against the contract rather than read as free JSON. */
async function readStatus(from: AppInstance = app) {
  const res = await from.inject({
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
    // Opened without writing its meta: the case after this one holds the page
    // to that, and a fixture that wrote it would teach the opposite.
    const queues = openTestQueues(redis);
    const queue = queues.get(PAUSE_QUEUE);
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
      // asserted where it is decided - `packages/db/test/stack-guard.test.ts` - rather
      // than by reading the Redis database that suite owns.
      expect(
        body.queues?.find((entry) => entry.name === PROBE_QUEUE),
      ).toMatchObject({ paused: false });
    } finally {
      await queue.resume();
      await queues.close();
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
    const reader = createQueueStats({ connection: redis, log: silentLogger() });
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

/**
 * A Postgres host that takes the connection and never answers it - a black
 * hole: the relay is silent from the first byte. The deadline of the section
 * (`DEPENDENCY_TIMEOUT_MS`) is armed before the connect and equals its bound,
 * so the page reads `timeout`, not `unreachable` (decision of 20.10.2026,
 * docs/adr/0002-db-connection-and-cli-config.md). What the connect bound of
 * the probe handle buys is that nothing is destroyed: the connect is refused
 * before the limit of the handle, no warning of the limit is written, and
 * once the host answers the next poll goes over the same client.
 */
describe("GET /system/status against a Postgres nobody answers", () => {
  it("reads the budget as timed out and keeps its client past the limit", async () => {
    const relay = await openRelay();
    relay.freeze();
    const { log, lines } = recordingLogger();
    // The handles as the composition opens them, warning on a limit included.
    const dbs = openProbeDbs(relay.url, log);
    /** The client every read of the budget ran on, in order. */
    const seen: Db[] = [];
    const budget: ProbeDb = {
      run: (fn) =>
        dbs.budget.run((client) => {
          seen.push(client);
          return fn(client);
        }),
      close: (opts) => dbs.budget.close(opts),
    };
    const own = buildApp(
      {
        health: createHealthProbes({ db: dbs.health, redis }),
        buildInfo: { version: "int", commit: "int" },
        // The budget is what this case is about; the Redis sections answer
        // from fixtures.
        queues: { collect: async () => EMPTY_QUEUES },
        worker: { read: async () => LIVE_WORKER },
        budget: createBudgetProbe({ db: budget, limits }),
      },
      { adminPassword: TEST_PASSWORD, logger: false },
    );
    try {
      await own.ready();
      const askedAt = performance.now();

      const silent = await readStatus(own);

      expect(silent.budget).toBeNull();
      expect(silent.checks.db).toEqual({ status: "down", reason: "timeout" });
      // Past the limit of the handle, with a margin: a connect that only
      // ended there would have destroyed the client and said so by now.
      await sleep(
        Math.max(0, askedAt + PROBE_QUERY_LIMIT_MS + 1_000 - performance.now()),
      );
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);

      relay.thaw();
      const back = await readStatus(own);

      expect(back.checks.db).toEqual({ status: "up", reason: null });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]);
    } finally {
      await own.close();
      relay.thaw();
      await dbs.close();
      await relay.cut();
    }
  }, 20_000);
});

/**
 * The connection of this suite, not of a forked api: what a forked process
 * dials is checked by its client ids in `entry-point.int.test.ts`.
 */
describe("the Redis of the api suite", () => {
  it("is the api's own database, not the one the worker suite takes jobs from", async () => {
    // The pause above must not reach a queue of the worker suite: the two
    // keep apart by database, and this is the connection every case uses.
    expect(redis.options.db).toBe(Number(TEST_REDIS_DATABASE_OF.api));
    expect(redis.options.db).not.toBe(Number(TEST_REDIS_DATABASE_OF.worker));
    // And the server agrees: a connection the same factory opens really sits
    // in that database. A client of the case's own, fresh rather than warmed
    // up by the cases above, and asked once its socket is up: with no offline
    // queue a command sent while the client is still connecting is refused.
    const own = openTestRedis();
    try {
      await whenReady(own);
      const info = await own.client("INFO");
      expect(String(info)).toMatch(
        new RegExp(`\\bdb=${TEST_REDIS_DATABASE_OF.api}\\b`),
      );
    } finally {
      own.disconnect();
    }
  });
});
