import { env } from "@sf/config";
import { jobIds } from "@sf/core";
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
 * A job that has spent its attempts ends up in `system.dlq` with everything an
 * operator needs to see what happened (decision 4 of E0). Against a real
 * BullMQ: the `failed` event, the attempt counting and the custom id of the
 * record are all things a fake would only pretend to do.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;

const FAILURE = "smoke handler exploded";

/** What a dlq record has to carry for E13-02 to make sense of it. */
const DlqRecordSchema = z
  .object({
    queue: z.string(),
    jobId: z.string(),
    name: z.string(),
    data: z.unknown(),
    failedReason: z.string(),
    stacktrace: z.array(z.string()),
    attemptsMade: z.number(),
    failedAt: z.string(),
  })
  .strict();

const failingJob = defineJob({
  queue: "system.smoke",
  payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
  jobIdFrom: (payload) => `system.smoke/${payload.marker}`,
  handler: async () => {
    throw new Error(FAILURE);
  },
  // One attempt: the retry policy is tested by its own unit test, and five
  // exponential backoffs would take this file past any sane timeout.
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
    processors: { "system.smoke": failingJob },
    switchIntervalMs: 60_000,
  });
});

afterAll(async () => {
  await runtime.close();
  await obliterateQueues(redis, QUEUES);
  await closeDb(db);
  await closeRedis(redis);
});

describe("dead letter queue", () => {
  it("copies a job that ran out of attempts, with its queue, id and reason", async () => {
    const marker = `dlq-${Date.now()}`;
    const jobId = await failingJob.enqueue(runtime.queues.get("system.smoke"), {
      marker,
    });

    const dlq = runtime.queues.get("system.dlq");
    const record = await waitFor(
      async () => {
        const jobs = await dlq.getJobs(["waiting", "prioritized", "delayed"]);
        return jobs.find(
          (job) => DlqRecordSchema.safeParse(job.data).data?.jobId === jobId,
        );
      },
      { what: `the dlq record of ${jobId}` },
    );
    const stored = DlqRecordSchema.parse(record.data);

    expect(stored).toMatchObject({
      queue: "system.smoke",
      jobId,
      name: "system.smoke",
      attemptsMade: 1,
    });
    expect(stored.failedReason).toContain(FAILURE);
    expect(stored.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The id of the record is derived, so a second `failed` for the same
    // instance - a worker restarted while the job was dying - leaves one
    // record rather than two.
    const original = await runtime.queues.get("system.smoke").getJob(jobId);
    expect(original).toBeDefined();
    expect(record.id).toBe(
      jobIds.dlqEntry("system.smoke", jobId, original?.timestamp ?? 0),
    );
  });

  it("keeps a job that still has attempts out of the dlq", async () => {
    // The `failed` event fires after every attempt; without the check the same
    // job would be copied four times before it even succeeds.
    const dlq = runtime.queues.get("system.dlq");
    const before = await dlq.getJobCountByTypes("waiting");

    const retried = defineJob({
      queue: "system.smoke",
      payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
      jobIdFrom: (payload) => `system.smoke/${payload.marker}`,
      handler: async () => {
        throw new Error(FAILURE);
      },
      opts: { attempts: 3, backoff: { type: "fixed", delay: 30_000 } },
    });
    const marker = `retry-${Date.now()}`;
    await retried.enqueue(runtime.queues.get("system.smoke"), { marker });

    // Long enough for the first attempt to fail; the second is half a minute
    // away, so a copy appearing here could only be the wrong one.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await dlq.getJobCountByTypes("waiting")).toBe(before);
  });
});
