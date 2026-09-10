import { env } from "@sf/config";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { type Db, createDb } from "@sf/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { systemHeartbeatJob } from "../src/jobs/system-heartbeat.js";
import { closeRedis } from "../src/lib/redis.js";
import { openTestRedis, testLogger } from "./helpers.int.js";

/**
 * The liveness stamp against a real Redis: what a fake cannot have is the
 * expiry. `/system/status` (E0-09) and the healthcheck of E0-11 read "no key"
 * as "the worker is down", so a `SET` without a TTL - or with one Redis does
 * not accept - is a worker that looks alive forever.
 *
 * Redis is the only thing this file opens. The database is part of
 * `JobRuntimeDeps` and this job never queries it, and postgres-js connects on
 * the first query - so the handle below stays a handle, and there is nothing
 * to close. A pool opened for a case about Redis is a connection per run that
 * proves nothing.
 */
const db: Db = createDb(env.DATABASE_URL, { max: 1 });
const redis = openTestRedis();

beforeEach(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
});

afterAll(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
  await closeRedis(redis);
});

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
      { log: testLogger(), db, redis },
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

    await systemHeartbeatJob.process(job, { log: testLogger(), db, redis });
    const first = await redis.get(WORKER_HEARTBEAT_KEY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await systemHeartbeatJob.process(job, { log: testLogger(), db, redis });

    const second = await redis.get(WORKER_HEARTBEAT_KEY);
    expect(second).not.toBe(first);
    // One key, whatever the number of ticks: the reader looks at one name.
    expect(await redis.keys(`${WORKER_HEARTBEAT_KEY}*`)).toEqual([
      WORKER_HEARTBEAT_KEY,
    ]);
  });
});
