import { env } from "@sf/config";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { type Db, closeDb } from "@sf/db";
import type { QueueFactory } from "@sf/runtime";
import { closeRedis } from "@sf/runtime";
import {
  type LoggedLine,
  recordingLogger,
  silentLogger,
} from "@sf/runtime/test-support/recording-logger";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { type Logger, pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap.js";
import { systemHeartbeatJob } from "../src/jobs/system-heartbeat.js";
import { systemSmokeJob } from "../src/jobs/system-smoke.js";
import { startWorkerRuntime } from "../src/runtime.js";
import {
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  workerQueueFactory,
} from "./helpers.int.js";
import { recordingUsage, unusedBudget } from "./job-deps.js";

/**
 * The liveness stamp against a real Redis: what a fake cannot have is the
 * expiry. `/system/status` (E0-09) and the healthcheck of E0-11 read "no key"
 * as "the worker is down", so a `SET` without a TTL - or with one Redis does
 * not accept - is a worker that looks alive forever.
 *
 * The job cases open only Redis. The database is part of `JobRuntimeDeps`
 * and this job never queries it, and postgres-js connects on the first query -
 * so the handle below stays a handle, and there is nothing to close. A pool
 * opened for a case about Redis is a connection per run that proves nothing.
 * The start cases are the exception: the runtime reads the queue switches, so
 * each opens a database of its own and closes it, and they leave a heartbeat
 * scheduler and its ticks in Redis, cleared around the file.
 */
const db: Db = openTestDb();
const redis = openTestRedis();

const QUEUES = ["system.heartbeat", "system.smoke", "system.dlq"] as const;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
});

beforeEach(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
});

afterAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await redis.del(WORKER_HEARTBEAT_KEY);
  await closeRedis(redis);
});

/** The heartbeat spends nothing: both spend-related deps refuse to be used. */
function jobDeps() {
  return {
    log: silentLogger(),
    db,
    redis,
    budget: unusedBudget(),
    createUsage: recordingUsage().createUsage,
  };
}

describe("system.heartbeat against redis", () => {
  it("leaves a stamp that expires on its own", async () => {
    const before = Date.now();

    await systemHeartbeatJob.process(
      {
        id: "system.heartbeat/29817598",
        name: "system.heartbeat",
        data: {},
        attemptsMade: 0,
        timestamp: before,
      },
      jobDeps(),
    );

    const stamp = await redis.get(WORKER_HEARTBEAT_KEY);
    expect(stamp).not.toBeNull();
    expect(Date.parse(String(stamp))).toBeGreaterThanOrEqual(before);

    const ttl = await redis.ttl(WORKER_HEARTBEAT_KEY);
    // -1 is "no expiry at all", which is the failure this test exists for.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WORKER_HEARTBEAT_TTL_SEC);
  });

  it("overwrites the previous stamp instead of piling up keys", async () => {
    const job = {
      id: "system.heartbeat/29817599",
      name: "system.heartbeat",
      data: {},
      attemptsMade: 0,
      timestamp: Date.now(),
    };

    await systemHeartbeatJob.process(job, jobDeps());
    const first = await redis.get(WORKER_HEARTBEAT_KEY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await systemHeartbeatJob.process(job, jobDeps());

    const second = await redis.get(WORKER_HEARTBEAT_KEY);
    expect(second).not.toBe(first);
    // One key, whatever the number of ticks: the reader looks at one name.
    expect(await redis.keys(`${WORKER_HEARTBEAT_KEY}*`)).toEqual([
      WORKER_HEARTBEAT_KEY,
    ]);
  });
});

/**
 * The test Redis with its `DEL` taken over: `onDel` runs instead of the
 * command, or before it when it returns nothing. Everything else is the real
 * client.
 */
function redisWithDel(
  real: Redis,
  onDel: (keys: readonly unknown[]) => Promise<number> | undefined,
): Redis {
  return new Proxy(real, {
    get(target: Redis, prop: string | symbol): unknown {
      if (prop === "del") {
        return async (...args: Parameters<Redis["del"]>) =>
          (await onDel(args)) ?? (await target.del(...args));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The real queue factory, noting every queue the start asks for and every
 * job scheduler it writes - the schedules are what the start does with a queue
 * after the switches.
 */
function noting(real: QueueFactory, events: string[]): QueueFactory {
  return {
    get(name): Queue {
      events.push(`queue:${name}`);
      const queue = real.get(name);
      return new Proxy(queue, {
        get(target: Queue, prop: string | symbol): unknown {
          if (prop === "upsertJobScheduler") {
            return (...args: Parameters<Queue["upsertJobScheduler"]>) => {
              events.push(`schedule:${name}`);
              return target.upsertJobScheduler(...args);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    use: (name, read) => real.use(name, read),
    close: () => real.close(),
  };
}

/** A logger that notes every `Worker` the start creates, in `events`. */
function notingWorkers(events: string[]): Logger {
  return pino(
    { level: "info" },
    {
      write: (line: string) => {
        const { msg, queue } = JSON.parse(line) as LoggedLine;
        if (msg === "worker started") {
          events.push(`worker:${String(queue)}`);
        }
      },
    },
  );
}

describe("worker start against redis", () => {
  it("clears the stamp a previous process left behind", async () => {
    // A fresh stamp from the process before this one, still inside its TTL -
    // the `redisdata` volume keeps it across a restart, and the healthcheck
    // would call the new worker alive before it has done anything.
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );
    // The runtime reads the queue switches before it starts anything, so this
    // case needs a database that is really there - and closes it after.
    const runtimeDb = openTestDb();
    try {
      await seedQueueSwitches(runtimeDb);
      const runtime = await startWorkerRuntime({
        env,
        db: runtimeDb,
        redis,
        log: silentLogger(),
        processors: {},
        switchIntervalMs: 60_000,
      });
      try {
        expect(await redis.get(WORKER_HEARTBEAT_KEY)).toBeNull();
      } finally {
        await runtime.close();
      }
    } finally {
      await closeDb(runtimeDb);
    }
  });

  it("clears the stamp after the switches and before the schedules and any worker", async () => {
    // The switches come first: a database that was never seeded must be the
    // first error the operator sees. The schedules and the workers come after:
    // a stamp cleared once a job could run might be the fresh one this
    // process's own first tick has just written.
    const events: string[] = [];
    const runtimeDb = openTestDb();
    try {
      await seedQueueSwitches(runtimeDb);
      const runtime = await startWorkerRuntime({
        env,
        db: runtimeDb,
        redis: redisWithDel(redis, (keys) => {
          events.push(`del:${keys.join(",")}`);
          return undefined;
        }),
        log: notingWorkers(events),
        processors: { "system.smoke": systemSmokeJob },
        switchIntervalMs: 60_000,
        queues: noting(workerQueueFactory(redis), events),
      });
      await runtime.close();
    } finally {
      await closeDb(runtimeDb);
    }

    const del = events.indexOf(`del:${WORKER_HEARTBEAT_KEY}`);
    expect(events.filter((event) => event.startsWith("del:"))).toHaveLength(1);
    // Before the delete: the queues the switches read, and nothing else.
    const before = events.slice(0, del);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((event) => event.startsWith("queue:"))).toBe(true);
    // After it: the schedules and the worker - not vacuous, both did start.
    const after = events.slice(del + 1);
    expect(after.some((event) => event.startsWith("schedule:"))).toBe(true);
    expect(after).toContain("worker:system.smoke");
  });

  it("fails the start when the stamp cannot be cleared", async () => {
    // Through the entry point's order, the way production starts: a refused
    // `DEL` is a start that failed - logged as fatal, exit code 1 - not a
    // worker that comes up next to a stamp it does not own.
    const { log, lines } = recordingLogger();
    const codes: number[] = [];
    const events: string[] = [];
    // The queues the start opens are closed here, whatever the start did: the
    // case is about the start failing, and must not lean on that failure
    // closing what it opened.
    const queueFactory = workerQueueFactory(redis);
    const runtimeDb = openTestDb();
    try {
      await seedQueueSwitches(runtimeDb);
      const runtime = await bootstrap({
        log,
        start: () =>
          startWorkerRuntime({
            env,
            db: runtimeDb,
            redis: redisWithDel(redis, () =>
              Promise.reject(new Error("READONLY the stamp is not ours")),
            ),
            log,
            processors: {},
            switchIntervalMs: 60_000,
            queues: noting(queueFactory, events),
          }),
        connections: [],
        subscribe: () => {},
        exit: (code) => codes.push(code),
      });
      // Closed if it did come up, so that a red case leaves no queue behind.
      await runtime?.close();

      expect(runtime).toBeUndefined();
    } finally {
      await queueFactory.close();
      await closeDb(runtimeDb);
    }

    expect(codes).toEqual([1]);
    const fatal = lines.find((line) => line.level === "fatal");
    expect(fatal?.msg).toBe("worker failed to start");
    expect(JSON.stringify(fatal?.err)).toContain(
      "READONLY the stamp is not ours",
    );
    // It stopped where it failed: the switches were read, and nothing after
    // the delete - no schedule, no worker - was started.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.startsWith("queue:"))).toBe(true);
    expect(lines.map((line) => line.msg)).not.toContain("worker started");
  });
});
