import { env } from "@sf/config";
import { closeDb } from "@sf/db";
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
 * The half of the DoD a signal cannot be sent for on Windows: `Ctrl+C` must
 * not cost the job that is running. `createShutdownHandler` puts the workers
 * first (its own unit test), and this is the part underneath - that closing a
 * worker really does wait for the handler in flight instead of cutting it off.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;

/** Long enough that a close which does not wait would finish before it. */
const JOB_DURATION_MS = 1_200;

let finished = false;

const slowJob = defineJob({
  queue: "system.smoke",
  payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
  jobIdFrom: (payload) => `system.smoke/${payload.marker}`,
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, JOB_DURATION_MS));
    finished = true;
  },
  opts: { attempts: 1 },
});

const db = openTestDb();
const redis = openTestRedis();
let runtime: WorkerRuntime;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db);
  runtime = await startWorkerRuntime({
    env,
    db,
    redis,
    log: testLogger(),
    processors: { "system.smoke": slowJob },
    switchIntervalMs: 60_000,
  });
});

afterAll(async () => {
  await runtime.close();
  await obliterateQueues(redis, QUEUES);
  await closeDb(db);
  await closeRedis(redis);
});

describe("graceful shutdown", () => {
  it("waits for the job in flight before it lets go of the worker", async () => {
    const queue = runtime.queues.get("system.smoke");
    const jobId = await slowJob.enqueue(queue, {
      marker: `drain-${Date.now()}`,
    });

    await waitFor(
      async () => ((await queue.getActiveCount()) > 0 ? true : undefined),
      { what: "the job to start" },
    );
    expect(finished).toBe(false);

    await runtime.closeWorkers();

    expect(finished).toBe(true);
    const job = await queue.getJob(jobId);
    expect(await job?.getState()).toBe("completed");
  });
});
