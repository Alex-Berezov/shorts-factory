import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { type Db, closeDb, createDb } from "@sf/db";
import { Redis } from "ioredis";
import { pino } from "pino";
import { type MockInstance, afterAll, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MIN,
  createSystemHeartbeatJob,
  systemHeartbeatJob,
} from "../src/jobs/system-heartbeat.js";
import type { JobRuntimeDeps, ProcessableJob } from "../src/lib/define-job.js";

/**
 * The stamp `/system/status` (E0-09) and the container healthcheck (E0-11)
 * read. Every part of it is a contract with a reader that is not written yet:
 * the key name, the value and the TTL - the TTL being what turns "no stamp"
 * into "the worker is down" rather than "the worker never ran".
 *
 * The connections are real objects and neither of them is ever opened:
 * `lazyConnect` keeps ioredis off the socket until a command is sent, `set` is
 * replaced before that can happen, and postgres-js connects on the first
 * query, which the handler does not make.
 */
const db: Db = createDb("postgres://sf:sf@localhost:5442/shorts_factory_test", {
  max: 1,
});

afterAll(async () => {
  await closeDb(db);
});

/** Deps whose Redis records the `SET` instead of sending it. */
function depsWithRecordedSet(): {
  deps: JobRuntimeDeps;
  redis: Redis;
  set: MockInstance<Redis["set"]>;
} {
  const redis = new Redis({ lazyConnect: true });
  const set = vi.spyOn(redis, "set").mockResolvedValue("OK");
  return { deps: { log: pino({ level: "silent" }), db, redis }, redis, set };
}

/** A queue that keeps the ids it was asked to add. */
function recordingQueue(): {
  target: {
    add(
      name: string,
      data: unknown,
      opts?: { jobId?: string },
    ): Promise<{ id?: string | undefined }>;
  };
  added: (string | undefined)[];
} {
  const added: (string | undefined)[] = [];
  return {
    added,
    target: {
      add: async (_name, _data, opts) => {
        added.push(opts?.jobId);
        return { id: opts?.jobId };
      },
    },
  };
}

/** A clock that answers with the given moments, in order, then repeats the last. */
function nextOf(moments: readonly Date[]): () => Date {
  let index = 0;
  return () => {
    const moment = moments[Math.min(index, moments.length - 1)];
    index += 1;
    if (moment === undefined) {
      throw new Error("the fake clock was built without a moment");
    }
    return moment;
  };
}

function heartbeatJob(overrides: Partial<ProcessableJob> = {}): ProcessableJob {
  return {
    id: "system.heartbeat/29817598",
    name: "system.heartbeat",
    data: {},
    attemptsMade: 0,
    timestamp: 1_789_000_000_000,
    ...overrides,
  };
}

describe("system.heartbeat", () => {
  it("writes the stamp under the shared key, with the shared ttl", async () => {
    // The key and the TTL come from `@sf/core` because the reader lives in
    // another service: a literal spelled twice drifts, and the reader cannot
    // tell a renamed key from a worker that died.
    const { deps, redis, set } = depsWithRecordedSet();
    const before = Date.now();

    await systemHeartbeatJob.process(heartbeatJob(), deps);
    redis.disconnect();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      WORKER_HEARTBEAT_KEY,
      expect.any(String),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );
    const stamp = String(set.mock.calls[0]?.[1]);
    // An ISO timestamp of now, not a counter or a formatted local time: the
    // reader compares it with its own clock.
    expect(new Date(stamp).toISOString()).toBe(stamp);
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
  });

  it("outlives more than one missed tick", () => {
    // A TTL shorter than the interval expires between two ticks, and the
    // healthcheck of E0-11 restarts a worker that is perfectly alive.
    expect(WORKER_HEARTBEAT_TTL_SEC).toBeGreaterThan(
      HEARTBEAT_INTERVAL_MIN * 60,
    );
  });

  it("gives one job id per interval, so a repeat is deduplicated", async () => {
    // The scheduler fires once a minute and BullMQ drops a duplicate id; two
    // ticks of the same minute must not become two jobs.
    //
    // The clock is the definition's, not the module's: read inside
    // `jobIdFrom`, two calls milliseconds apart would land in different
    // minutes whenever the run crossed a boundary, and this case would fail
    // for a reason that has nothing to do with the job.
    const queue = recordingQueue();
    const inOneMinute = createSystemHeartbeatJob(
      nextOf([
        new Date("2026-09-10T15:24:00.400Z"),
        new Date("2026-09-10T15:24:59.900Z"),
      ]),
    );

    const first = await inOneMinute.enqueue(queue.target, {});
    const second = await inOneMinute.enqueue(queue.target, {});

    expect(first).toMatch(/^system\.heartbeat\/\d+$/);
    expect(second).toBe(first);
    expect(queue.added).toEqual([first, first]);
  });

  it("gives the next minute an id of its own", async () => {
    // The other half of the same contract: a tick that belongs to another
    // minute is another job, not a duplicate BullMQ would drop - otherwise a
    // stamp older than its TTL would never be refreshed.
    const queue = recordingQueue();
    const acrossTheBoundary = createSystemHeartbeatJob(
      nextOf([
        new Date("2026-09-10T15:24:59.900Z"),
        new Date("2026-09-10T15:25:00.100Z"),
      ]),
    );

    const first = await acrossTheBoundary.enqueue(queue.target, {});
    const second = await acrossTheBoundary.enqueue(queue.target, {});

    expect(second).not.toBe(first);
  });

  it("refuses data that is not the empty payload", async () => {
    // The job takes nothing; anything else in `data` means it was put on the
    // queue by something that does not know what this job is.
    const { deps, redis, set } = depsWithRecordedSet();

    await expect(
      systemHeartbeatJob.process(
        heartbeatJob({ data: { stamp: "now" } }),
        deps,
      ),
    ).rejects.toThrow(/payload does not match the schema/);
    redis.disconnect();

    expect(set).not.toHaveBeenCalled();
  });
});
