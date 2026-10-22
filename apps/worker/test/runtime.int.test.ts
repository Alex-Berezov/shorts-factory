import { env } from "@sf/config";
import type { QueueName } from "@sf/core";
import { closeDb } from "@sf/db";
import type { QueueFactory } from "@sf/runtime";
import { closeRedis } from "@sf/runtime";
import { silentLogger } from "@sf/runtime/test-support/recording-logger";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineJob } from "../src/lib/define-job.js";
import { startWorkerRuntime } from "../src/runtime.js";
import {
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  waitFor,
  workerQueueFactory,
} from "./helpers.int.js";

/**
 * What the runtime does while it is stopping, against a real Redis.
 *
 * The copy of a finally failed job travels to `system.dlq` from an event
 * listener, and a listener is not something `worker.close()` waits for. To see
 * whether the stop waits for it anyway, the write is slowed down here on
 * purpose: with a real Redis it takes a millisecond, and a race that is lost
 * only on a loaded machine is a race no test would ever catch.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;

/** Long enough that a stop which does not wait finishes well before it. */
const DLQ_WRITE_DELAY_MS = 800;

const failingJob = defineJob({
  queue: "system.smoke",
  payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
  jobIdFrom: (payload) => `system.smoke/${payload.marker}`,
  handler: async () => {
    throw new Error("this job always fails");
  },
  opts: { attempts: 1 },
});

/** The real factory, with the write into `system.dlq` made slow. */
function withSlowDlqWrites(real: QueueFactory, delayMs: number): QueueFactory {
  return {
    get(name: QueueName): Queue {
      const queue = real.get(name);
      if (name !== "system.dlq") {
        return queue;
      }
      return new Proxy(queue, {
        get(target: Queue, prop: string | symbol): unknown {
          if (prop === "add") {
            return async (...args: Parameters<Queue["add"]>) => {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return await target.add(...args);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    use: (name, read) => real.use(name, read),
    clientErrors: real.clientErrors,
    close: () => real.close(),
  };
}

/**
 * `Worker.close()` that closes for real and then refuses, so the case leaves
 * no worker on the client: the first call only, or every call.
 */
function refuseWorkerClose(message: string, calls: "once" | "always" = "once") {
  const closeOfWorker = Worker.prototype.close;
  const refusing = async function (this: Worker): Promise<void> {
    await closeOfWorker.call(this);
    throw new Error(message);
  };
  const spy = vi.spyOn(Worker.prototype, "close");
  return calls === "once"
    ? spy.mockImplementationOnce(refusing)
    : spy.mockImplementation(refusing);
}

/** Whether the mark of the factory still marks an error of the shared client. */
function clientMarks(factory: QueueFactory): boolean {
  const err = new Error("emitted after the close");
  // Listeners of the case's own: an `error` with none would throw here, and
  // the reader of the case hears the client too (BullMQ hands it on).
  const heard = (): void => {};
  redis.on("error", heard);
  dlqReader.on("error", heard);
  try {
    redis.emit("error", err);
  } finally {
    redis.off("error", heard);
    dlqReader.off("error", heard);
  }
  return factory.clientErrors.has(err);
}

const db = openTestDb();
const redis = openTestRedis();
/** Read side, opened by the test: the runtime closes its own queues. */
const dlqReader = new Queue("system.dlq", { connection: redis });

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db);
});

afterAll(async () => {
  await dlqReader.close();
  await obliterateQueues(redis, QUEUES);
  await closeDb(db);
  await closeRedis(redis);
});

describe("worker runtime", () => {
  it("waits for a dead letter copy that is still in flight", async () => {
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: { "system.smoke": failingJob },
      queues: withSlowDlqWrites(workerQueueFactory(redis), DLQ_WRITE_DELAY_MS),
      switchIntervalMs: 60_000,
    });

    const queue = runtime.queues.get("system.smoke");
    const jobId = await failingJob.enqueue(queue, {
      marker: `dlq-drain-${Date.now()}`,
    });

    await waitFor(
      async () => {
        const job = await queue.getJob(jobId);
        return (await job?.getState()) === "failed" ? true : undefined;
      },
      { what: "the job to run out of attempts" },
    );
    // The state reaches Redis just before the listener runs; this is the gap
    // between the two, not a wait for the copy itself.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await runtime.close();

    // Read through a connection of the test: the runtime has closed its own.
    expect(await dlqReader.getJobCountByTypes("wait")).toBe(1);
    const [record] = await dlqReader.getJobs(["wait"], 0, 0);
    expect(record?.data).toMatchObject({
      queue: "system.smoke",
      jobId,
      failedReason: "this job always fails",
    });
  });

  it("closes what it opened when the start fails halfway", async () => {
    // The caller has no handle on a runtime that never returned: a `Worker`
    // already taking jobs, a resync timer and the queues would stay open on a
    // process that is about to exit, and the entry point would close only the
    // connections underneath them.
    const real = workerQueueFactory(redis);
    let closed = false;
    let heartbeatAsked = 0;
    const factory: QueueFactory = {
      get(name: QueueName): Queue {
        if (name === "system.heartbeat") {
          heartbeatAsked += 1;
          // The first pass is the switch sync; the second is `syncSchedules`,
          // by which time the timer is running and the queues are open.
          if (heartbeatAsked > 1) {
            throw new Error("redis went away mid-start");
          }
        }
        return real.get(name);
      },
      use: (name, read) => real.use(name, read),
      clientErrors: real.clientErrors,
      close: async () => {
        closed = true;
        await real.close();
      },
    };

    await expect(
      startWorkerRuntime({
        env,
        db,
        redis,
        log: silentLogger(),
        processors: { "system.smoke": failingJob },
        queues: factory,
        switchIntervalMs: 50,
      }),
    ).rejects.toThrow("redis went away mid-start");

    expect(closed).toBe(true);
    // And the resync is not still running against a closed factory.
    const askedRightAfter = heartbeatAsked;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heartbeatAsked).toBe(askedRightAfter);
  });

  it("closes its queues even when a worker refuses to close, and says why", async () => {
    // Only the factory takes the mark off the client: a close that stopped at
    // the refusing worker left the queues and the mark on it.
    const real = workerQueueFactory(redis);
    let closed = false;
    const factory: QueueFactory = {
      get: (name) => real.get(name),
      use: (name, read) => real.use(name, read),
      clientErrors: real.clientErrors,
      close: async () => {
        closed = true;
        await real.close();
      },
    };
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: { "system.smoke": failingJob },
      queues: factory,
      switchIntervalMs: 60_000,
    });
    const close = refuseWorkerClose("the worker refused to close");

    try {
      await expect(runtime.close()).rejects.toThrow(
        "the worker refused to close",
      );
    } finally {
      close.mockRestore();
    }

    expect(closed).toBe(true);
    // And the mark is off the client: an error it emits now is not marked.
    expect(clientMarks(real)).toBe(false);
  });

  it("keeps a dead letter copy in flight when a worker refuses to close", async () => {
    // The refusal used to end the stage before the drain, and `close()` then
    // closed the factory under the copy on its way to `system.dlq`.
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: { "system.smoke": failingJob },
      queues: withSlowDlqWrites(workerQueueFactory(redis), DLQ_WRITE_DELAY_MS),
      switchIntervalMs: 60_000,
    });

    const queue = runtime.queues.get("system.smoke");
    const jobId = await failingJob.enqueue(queue, {
      marker: `dlq-refused-${Date.now()}`,
    });
    await waitFor(
      async () => {
        const job = await queue.getJob(jobId);
        return (await job?.getState()) === "failed" ? true : undefined;
      },
      { what: "the job to run out of attempts" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const close = refuseWorkerClose("the worker refused to close");
    try {
      await expect(runtime.close()).rejects.toThrow(
        "the worker refused to close",
      );
    } finally {
      close.mockRestore();
    }

    const records = await dlqReader.getJobs(["wait"]);
    expect(
      records.filter((record) => record.data?.jobId === jobId),
    ).toHaveLength(1);
  });

  it("throws the refusals of every worker that refused to close, not the first one", async () => {
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: {
        "system.smoke": failingJob,
        "system.heartbeat": failingJob,
      },
      switchIntervalMs: 60_000,
    });

    const close = refuseWorkerClose("a worker refused to close", "always");
    let thrown: unknown;
    try {
      await runtime.close().catch((err: unknown) => {
        thrown = err;
      });
    } finally {
      close.mockRestore();
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toHaveLength(2);
    for (const err of errors) {
      expect(err).toMatchObject({ message: "a worker refused to close" });
    }
  });

  it("keeps the refusal of a worker when the queues refuse to close as well", async () => {
    const real = workerQueueFactory(redis);
    const factory: QueueFactory = {
      get: (name) => real.get(name),
      use: (name, read) => real.use(name, read),
      clientErrors: real.clientErrors,
      close: async () => {
        await real.close();
        throw new Error("the queues refused to close");
      },
    };
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: { "system.smoke": failingJob },
      queues: factory,
      switchIntervalMs: 60_000,
    });

    const close = refuseWorkerClose("the worker refused to close");
    let thrown: unknown;
    try {
      await runtime.close().catch((err: unknown) => {
        thrown = err;
      });
    } finally {
      close.mockRestore();
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toMatchObject([
      { message: "the worker refused to close" },
      { message: "the queues refused to close" },
    ]);
  });

  it("starts a worker only where a processor really is", async () => {
    // The registry is `Partial`, and a name whose value is `undefined` used to
    // pass a cast: the queue then looks served in the log while the first job
    // dies on a processor that is not there.
    const runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: silentLogger(),
      processors: {
        "system.smoke": failingJob,
        "system.heartbeat": undefined,
      },
      switchIntervalMs: 60_000,
    });

    expect(runtime.handled).toEqual(["system.smoke"]);

    await runtime.close();
  });
});
