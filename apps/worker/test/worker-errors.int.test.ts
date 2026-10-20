import { env } from "@sf/config";
import type { QueueName } from "@sf/core";
import { closeDb } from "@sf/db";
import { type QueueFactory, closeRedis } from "@sf/runtime";
import type * as SfRuntime from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { defineJob } from "../src/lib/define-job.js";
import {
  CONNECTION_FAILURE_LOG_WINDOW_MS,
  type WorkerRuntime,
  startWorkerRuntime,
} from "../src/runtime.js";
import {
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  workerQueueFactory,
} from "./helpers.int.js";

/**
 * The `error` listener of every `Worker` of the runtime, against a real Redis
 * and real BullMQ: BullMQ hands every error of the shared client to every
 * `Worker` on it (`RedisConnection` re-emits it), so the listener has to tell
 * such a copy from an error of the `Worker` itself - otherwise one error of
 * the shared client is one `worker error` line per queue per reconnect
 * (docs/TECH_DEBT.md § E0-12G, item 3, L-026). The errors of the blocking copy of the client
 * each `Worker` holds are other objects and are written: a connection failure
 * once, and again after the worker says `ready` or after
 * `CONNECTION_FAILURE_LOG_WINDOW_MS` (docs/DECISIONS.md, Т9 E0-12G). A wrong
 * password on those copies is still a line per worker per reconnect
 * (docs/TECH_DEBT.md § E0-12R). The `error` listeners left on the shared
 * client after `close()` are docs/TECH_DEBT.md § E0-12R as well.
 */
const QUEUES = ["system.smoke", "system.heartbeat", "system.dlq"] as const;

/** A job nobody enqueues: the case is about the listeners, not about jobs. */
function idleJob(queue: QueueName) {
  return defineJob({
    queue,
    payloadSchema: z.object({ marker: z.string().min(1) }).strict(),
    jobIdFrom: (payload) => `${queue}/${payload.marker}`,
    handler: async () => undefined,
    opts: { attempts: 1 },
  });
}

/**
 * The listeners the runtime's mark put on a client, by identity: the call of
 * `markClientErrors` is watched, not the order of `on("error")`.
 */
const marks = vi.hoisted(() => ({ listeners: [] as unknown[] }));
vi.mock("@sf/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof SfRuntime>();
  return {
    ...actual,
    markClientErrors: (connection: Redis) => {
      const before = new Set(connection.listeners("error"));
      const marked = actual.markClientErrors(connection);
      marks.listeners.push(
        ...connection.listeners("error").filter((l) => !before.has(l)),
      );
      return marked;
    },
  };
});

const db = openTestDb();
const redis = openTestRedis();

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db);
  // The client writes its own errors (`createRedisHealthListeners` of the
  // client factories); an `error` with no listener would throw out of `emit`.
  redis.on("error", () => {});
});

afterAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await closeDb(db);
  await closeRedis(redis);
});

describe("the error listener of the workers", () => {
  let runtime: WorkerRuntime | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await runtime?.close();
    runtime = undefined;
    vi.restoreAllMocks();
  });

  /** The runtime with two workers, and the `Worker` objects it built. */
  async function startTwoWorkers(
    queues: QueueFactory = workerQueueFactory(redis),
  ): Promise<{
    workers: Worker[];
    lines: () => Record<string, unknown>[];
  }> {
    const built = vi.spyOn(Worker.prototype, "on");
    const recorder = recordingLogger();
    runtime = await startWorkerRuntime({
      env,
      db,
      redis,
      log: recorder.log,
      processors: {
        "system.smoke": idleJob("system.smoke"),
        "system.heartbeat": idleJob("system.heartbeat"),
      },
      queues,
      switchIntervalMs: 60_000,
    });
    const workers = [
      ...new Set(
        built.mock.contexts.filter(
          (context): context is Worker => context instanceof Worker,
        ),
      ),
    ];
    expect(workers).toHaveLength(2);
    return { workers, lines: () => recorder.entries() };
  }

  /** The `worker error` lines written so far. */
  function workerErrors(
    lines: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    return lines.filter((line) => line.msg === "worker error");
  }

  /** A connection failure, the way ioredis emits a refused connect. */
  function refused(): Error {
    return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), {
      code: "ECONNREFUSED",
    });
  }

  it("writes no line per worker for an error of the shared client", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first] = workers;

    // A wrong password is not a connection failure: without the mark every
    // `Worker` on the client writes it again.
    redis.emit(
      "error",
      Object.assign(
        new Error(
          "WRONGPASS invalid username-password pair or user is disabled.",
        ),
        { name: "ReplyError" },
      ),
    );
    // A connection failure of the shared client is the same object on every
    // worker, and marked as well.
    redis.emit("error", refused());
    // The control: the listener writes, and what it wrote is only this.
    first?.emit("error", new Error("Missing lock for job 7"));

    expect(workerErrors(lines())).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ message: "Missing lock for job 7" }),
      }),
    ]);
  });

  it("writes a connection failure that is not the shared client's, once per worker until it is ready again", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first, second] = workers;
    // `ready` of a worker is emitted through `setTimeout 0`, so the wait lets
    // the copies settle; what keeps the case synchronous is that each `emit`
    // and the `expect` after it run without an await between them (L-029).
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));

    // What the blocking copy of the client a `Worker` holds reports: a new
    // object on every reconnect, never seen by the shared client.
    for (const worker of workers) {
      worker.emit("error", refused());
      worker.emit("error", refused());
    }
    const queuesOf = () => workerErrors(lines()).map((line) => line.queue);
    expect(queuesOf()).toEqual([first?.name, second?.name]);

    // The copy came back and went again: that is news. The `ready` of the
    // copy is reproduced by hand; the reset by a real `ready` of BullMQ is
    // E0-12R.
    first?.emit("ready");
    first?.emit("error", refused());

    expect(queuesOf()).toEqual([first?.name, second?.name, first?.name]);
    expect(workerErrors(lines())).toEqual([
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({ code: "ECONNREFUSED" }),
      }),
      expect.anything(),
      expect.anything(),
    ]);
  });

  it("writes an unmarked connection failure again once the window has passed, with no ready in between", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first] = workers;
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    // Only the clock the listener reads: BullMQ's own timers keep running.
    vi.useFakeTimers({ toFake: ["performance"] });
    const queuesOf = () => workerErrors(lines()).map((line) => line.queue);

    // Not the copy's: an unmarked failure no `ready` will follow.
    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name]);

    // Within the window, without `ready`: silent.
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS - 1);
    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name]);

    // The window has passed since the line: the next outage is news.
    vi.advanceTimersByTime(1);
    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name, first?.name]);

    // And the window starts again from that line.
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS - 1);
    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name, first?.name]);
  });

  it("keeps the window by the monotonic clock when the wall clock is set back", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first] = workers;
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const queuesOf = () => workerErrors(lines()).map((line) => line.queue);

    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name]);

    // The wall clock goes an hour back; the window still ends on time.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS);
    first?.emit("error", refused());
    expect(queuesOf()).toEqual([first?.name, first?.name]);
  });

  it("writes an error of a worker itself, once", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first] = workers;

    first?.emit("error", new Error("Missing lock for job 42"));

    expect(workerErrors(lines())).toEqual([
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({ message: "Missing lock for job 42" }),
      }),
    ]);
  });

  it("takes its mark off the shared client once the workers are closed", async () => {
    // The factory of the queues, with a mark of its own (not watched: it is
    // `@sf/runtime`'s own import), is opened first.
    const queues = workerQueueFactory(redis);
    marks.listeners.length = 0;
    await startTwoWorkers(queues);
    expect(marks.listeners).toHaveLength(1);
    const [mark] = marks.listeners;
    expect(redis.listeners("error")).toContain(mark);

    await runtime?.closeWorkers();

    expect(redis.listeners("error")).not.toContain(mark);
  });
});
