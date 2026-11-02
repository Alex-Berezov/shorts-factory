import { env } from "@sf/config";
import { jobIds } from "@sf/core";
import { closeRedis } from "@sf/runtime";
import { silentLogger } from "@sf/runtime/test-support/recording-logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineJob } from "../src/lib/define-job.js";
import { type WorkerRuntime, startWorkerRuntime } from "../src/runtime.js";
import {
  keepDatabase,
  obliterateQueues,
  openTestRedis,
  seedQueueSwitches,
  startedRuntime,
  useTestDb,
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

/**
 * Enqueues `failingJob` the way the code does - its payload check, its id and
 * its options over `DEFAULT_JOB_OPTIONS` - with one option added on the way to
 * the queue: a creation time of the caller's, which no job definition sets.
 * Returns the id the job derived.
 */
async function addSmoke(marker: string, timestamp: number): Promise<string> {
  const queue = startedRuntime(runtime).queues.get("system.smoke");
  return failingJob.enqueue(
    {
      add: (name, data, opts) => queue.add(name, data, { ...opts, timestamp }),
    },
    { marker },
  );
}

/**
 * The cases that read a creation time back through Lua characterise Redis 7,
 * the major version of the image in `infra/docker-compose.yml` and in CI
 * (`redis:7-alpine`); they were measured on 7.4.7 (E0-12Q). On another major
 * version they fail here, by name, rather than as a wrong id further down: a
 * new image means measuring again, not editing the expectations.
 */
async function expectRedisMajor7(): Promise<void> {
  const info = await redis.info("server");
  const version = /^redis_version:(\S+)$/m.exec(info)?.[1];
  expect(
    version?.split(".")[0],
    `these cases were measured on Redis 7, the server runs ${version ?? "an unknown version"}`,
  ).toBe("7");
}

/** The dlq record of `jobId`, once the failure of the job has copied it. */
async function dlqRecordOf(jobId: string) {
  const dlq = startedRuntime(runtime).queues.get("system.dlq");
  return waitFor(
    async () => {
      const jobs = await dlq.getJobs(["waiting", "prioritized", "delayed"]);
      return jobs.find(
        (job) => DlqRecordSchema.safeParse(job.data).data?.jobId === jobId,
      );
    },
    { what: `the dlq record of ${jobId}` },
  );
}

const db = useTestDb({ beforeAll, afterAll }, { prepare: keepDatabase });
const redis = openTestRedis();
/** Unset until the `beforeAll` of the file starts it. */
let runtime: WorkerRuntime | undefined;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db());
  runtime = await startWorkerRuntime({
    env,
    db: db(),
    redis,
    log: silentLogger(),
    processors: { "system.smoke": failingJob },
    switchIntervalMs: 60_000,
  });
});

afterAll(async () => {
  try {
    await runtime?.close();
    await obliterateQueues(redis, QUEUES);
  } finally {
    await closeRedis(redis);
  }
});

describe("dead letter queue", () => {
  it("copies a job that ran out of attempts, with its queue, id and reason", async () => {
    const marker = `dlq-${Date.now()}`;
    const jobId = await failingJob.enqueue(
      startedRuntime(runtime).queues.get("system.smoke"),
      { marker },
    );

    const record = await dlqRecordOf(jobId);
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
    const original = await startedRuntime(runtime)
      .queues.get("system.smoke")
      .getJob(jobId);
    expect(original).toBeDefined();
    expect(record.id).toBe(
      jobIds.dlqEntry("system.smoke", jobId, original?.timestamp ?? 0),
    );
  });

  it("copies a job created at 2**53 under tail 0: Redis gives the stamp back whole", async () => {
    // Measured on Redis 7.4.7 (E0-12Q): BullMQ stores `opts.timestamp`
    // through Lua, and `2**53` comes back from `parseInt` whole, as
    // 9007199254740992. It is past the safe range, and `dlqTimestamp` turns
    // it into 0 rather than lose the copy to a refused id. The timestamp is
    // stamped on the way to the queue: no job definition sets one.
    await expectRedisMajor7();
    const jobId = await addSmoke(`lua-${Date.now()}`, 2 ** 53);

    const record = await dlqRecordOf(jobId);

    const original = await startedRuntime(runtime)
      .queues.get("system.smoke")
      .getJob(jobId);
    expect(original?.timestamp).toBe(2 ** 53);
    expect(record.id).toBe(jobIds.dlqEntry("system.smoke", jobId, 0));
  });

  it("gives two jobs whose creation times above 1e14 differ in the last digit two copy ids, each ending in its own time", async () => {
    // Two stamps that differ in their last digit come back from Lua apart
    // (measured on Redis 7.4.7, E0-12Q), so the tail of each copy is its own
    // creation time; ADR-0008 accepts a shared tail only for stamps that are
    // not safe integers.
    await expectRedisMajor7();
    const stamps = [123_456_789_012_345, 123_456_789_012_346] as const;
    const jobs: Array<{ jobId: string; timestamp: number }> = [];
    for (const [i, timestamp] of stamps.entries()) {
      jobs.push({
        jobId: await addSmoke(`e14-${i}-${Date.now()}`, timestamp),
        timestamp,
      });
    }

    for (const job of jobs) {
      const record = await dlqRecordOf(job.jobId);
      const original = await startedRuntime(runtime)
        .queues.get("system.smoke")
        .getJob(job.jobId);
      expect(original?.timestamp).toBe(job.timestamp);
      expect(record.id).toBe(
        jobIds.dlqEntry("system.smoke", job.jobId, job.timestamp),
      );
    }
  });

  it("keeps a job that still has attempts out of the dlq", async () => {
    // The `failed` event fires after every attempt; without the check the same
    // job would be copied four times before it even succeeds.
    const dlq = startedRuntime(runtime).queues.get("system.dlq");
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
    await retried.enqueue(startedRuntime(runtime).queues.get("system.smoke"), {
      marker,
    });

    // Long enough for the first attempt to fail; the second is half a minute
    // away, so a copy appearing here could only be the wrong one.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await dlq.getJobCountByTypes("waiting")).toBe(before);
  });
});
