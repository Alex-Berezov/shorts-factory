import { once } from "node:events";
import { env } from "@sf/config";
import type { QueueName } from "@sf/core";
import { closeDb } from "@sf/db";
import { type QueueFactory, closeRedis } from "@sf/runtime";
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
import { type WorkerRuntime, startWorkerRuntime } from "../src/runtime.js";
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
 * (docs/TECH_DEBT.md § E0-12G, item 3, L-026). The rule is
 * `workerErrorPolicy` of `@sf/runtime`, on the one mark the queue factory puts
 * on the client: the errors of the blocking copy of the client each `Worker`
 * holds are other objects - a refused password is not written, a connection
 * failure once, and again after the worker says `ready` or after
 * `CONNECTION_FAILURE_LOG_WINDOW_MS` (docs/DECISIONS.md, Т9 E0-12G). What the
 * runtime leaves on the shared client after `close()` is counted here too.
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
 * The listeners of the mark (`markClientErrors` of `@sf/runtime`) on the
 * client, by the name of the function the mark registers: the factory makes
 * its mark inside the package, where no mock of the barrel reaches.
 */
function marksOn(client: Redis): number {
  return client
    .listeners("error")
    .filter((listener) => listener.name === "mark").length;
}

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

  it("writes no line for a refused password of the blocking copies, however many workers hear it", async () => {
    // Each `Worker` holds a copy of the client of its own, and with a wrong
    // password every copy is refused on every reconnect - other objects than
    // the one the shared client emits, so the mark does not cover them.
    // A real refusal of this Redis: the server answers AUTH of a user it does
    // not know with WRONGPASS.
    const { workers, lines } = await startTwoWorkers();
    const probe = redis.duplicate();
    try {
      for (const worker of workers) {
        const refusal: unknown = await probe
          .call("AUTH", "sf-no-such-user", "wrong-password")
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        if (!(refusal instanceof Error)) {
          throw new Error("AUTH of an unknown user was not refused");
        }
        expect(refusal).toMatchObject({
          name: "ReplyError",
          message: expect.stringMatching(/^WRONGPASS /),
        });
        worker.emit("error", refusal);
      }
    } finally {
      await closeRedis(probe);
    }

    expect(workerErrors(lines())).toEqual([]);
  });

  it("writes a connection failure that is not the shared client's, once per worker until it is ready again", async () => {
    const { workers, lines } = await startTwoWorkers();
    const [first, second] = workers;
    // Each `emit` and the `expect` after it run without an await between
    // them, so no `ready` of BullMQ (emitted through `setTimeout 0`) can
    // land in between (L-029); the reset by a real `ready` is the next case.
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));

    // What the blocking copy of the client a `Worker` holds reports: a new
    // object on every reconnect, never seen by the shared client.
    for (const worker of workers) {
      worker.emit("error", refused());
      worker.emit("error", refused());
    }
    const queuesOf = () => workerErrors(lines()).map((line) => line.queue);
    expect(queuesOf()).toEqual([first?.name, second?.name]);

    // The copy came back and went again: that is news.
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

  it("writes a connection failure again once the blocking copy really came back", async () => {
    // No hand-made `ready`: the blocking connection of one worker is killed
    // on the server, ioredis reconnects it, and BullMQ says `ready` of its
    // own (`worker.js`, through `setTimeout 0`).
    const { workers, lines } = await startTwoWorkers();
    const [first, second] = workers;
    if (first === undefined || second === undefined) {
      throw new Error("the runtime started fewer than two workers");
    }
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    const linesOf = (worker: Worker) =>
      workerErrors(lines()).filter((line) => line.queue === worker.name);

    first.emit("error", refused());
    first.emit("error", refused());
    expect(linesOf(first)).toHaveLength(1);

    // The blocking copy is named after its queue (`bull:<base64 of the
    // name>`); the shared client has no name, and the other worker's copy
    // has its own.
    const name = `bull:${Buffer.from(first.name).toString("base64")}`;
    const clients = String(await redis.call("CLIENT", "LIST"))
      .split("\n")
      .filter((entry) => entry.includes(` name=${name} `));
    expect(clients).toHaveLength(1);
    const id = /(?:^|\s)id=(\d+)\s/.exec(clients[0] ?? "")?.[1];
    if (id === undefined) {
      throw new Error(`no id in the CLIENT LIST entry of ${name}`);
    }
    const ready = once(first, "ready");
    await redis.call("CLIENT", "KILL", "ID", id);
    await ready;

    first.emit("error", refused());

    expect(linesOf(first)).toHaveLength(2);
    // The other worker heard nothing of it.
    expect(linesOf(second)).toEqual([]);
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

  it("puts one mark on the shared client for all its queues and workers", async () => {
    // Two marks did one job twice, and taking one off left the other.
    expect(marksOn(redis)).toBe(0);

    await startTwoWorkers();

    expect(marksOn(redis)).toBe(1);
  });

  it("keeps the mark while a worker that refused to close still hears the client", async () => {
    const queues = workerQueueFactory(redis);
    const { workers, lines } = await startTwoWorkers(queues);
    const close = vi
      .spyOn(Worker.prototype, "close")
      .mockRejectedValueOnce(new Error("the worker refused to close"));

    await expect(runtime?.closeWorkers()).rejects.toThrow(
      "the worker refused to close",
    );
    // The refusing worker is still listening; an error of the client it
    // hears is still a copy, not a line - the mark still knows it.
    const shared = new Error("an error of the shared client");
    redis.emit("error", shared);

    expect(workerErrors(lines())).toEqual([]);
    expect(queues.clientErrors.has(shared)).toBe(true);

    // The clean-up: the worker the spy kept open is closed for real, and the
    // queues take the mark off - after which it knows nothing new.
    close.mockRestore();
    await Promise.all(workers.map((worker) => worker.close()));
    await runtime?.closeQueues();
    const later = new Error("an error after the close");
    redis.emit("error", later);
    expect(queues.clientErrors.has(later)).toBe(false);
  });

  it("leaves no listener on the shared client once it is closed", async () => {
    // Every queue the start touched - the switches open all of them, the
    // schedules read their job schedulers - put listeners on the client; a
    // job scheduler is a connection of its own on it, which BullMQ does not
    // close with its queue (L-026).
    const before = {
      error: redis.listenerCount("error"),
      close: redis.listenerCount("close"),
      ready: redis.listenerCount("ready"),
    };

    await startTwoWorkers();
    expect(redis.listenerCount("error")).toBeGreaterThan(before.error);
    await runtime?.close();

    expect({
      error: redis.listenerCount("error"),
      close: redis.listenerCount("close"),
      ready: redis.listenerCount("ready"),
    }).toEqual(before);
  });
});
