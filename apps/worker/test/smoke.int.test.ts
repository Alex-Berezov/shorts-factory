import { env } from "@sf/config";
import { closeDb } from "@sf/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemSmokeJob } from "../src/jobs/system-smoke.js";
import { closeRedis } from "../src/lib/redis.js";
import { type WorkerRuntime, startWorkerRuntime } from "../src/runtime.js";
import {
  deleteSmokeUsage,
  findUsageRow,
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  testLogger,
  waitFor,
} from "./helpers.int.js";

/**
 * The acceptance criterion of E0: a job goes through Redis, runs in the worker
 * runtime and leaves a priced row in Postgres. The runtime is the real one -
 * queues, workers, switches and schedulers - started in this process.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;

const db = openTestDb();
const redis = openTestRedis();
let runtime: WorkerRuntime;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await deleteSmokeUsage(db);
  await seedQueueSwitches(db);
  runtime = await startWorkerRuntime({
    env,
    db,
    redis,
    log: testLogger(),
    processors: { "system.smoke": systemSmokeJob },
    // The resync is not what this file is about; a tick in the middle of it
    // would add nothing but noise.
    switchIntervalMs: 60_000,
  });
});

afterAll(async () => {
  await runtime.close();
  await obliterateQueues(redis, QUEUES);
  await deleteSmokeUsage(db);
  await closeDb(db);
  await closeRedis(redis);
});

describe("system.smoke", () => {
  it("runs the job and writes what it cost", async () => {
    const jobId = await systemSmokeJob.enqueue(
      runtime.queues.get("system.smoke"),
      { requestedAtMs: Date.now() },
    );

    // Polled, not awaited on an event: the job runs in another event loop and
    // what is asserted is the row it leaves behind.
    const row = await waitFor(() => findUsageRow(db, jobId), {
      what: `the api_usage_log row of job ${jobId}`,
    });

    expect(row).toEqual({ provider: "system", operation: "smoke", units: 0 });
  });
});
