import { HealthResponseSchema } from "@sf/contracts";
import { closeDb } from "@sf/db";
import { connectionFailure, createRequestRedis, errorCode } from "@sf/runtime";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { type AppInstance, buildApp } from "../src/app.js";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";
import { createHealthProbes } from "../src/lib/health.js";
import { openTestDb, openTestRedis, whenReady } from "./helpers.int.js";
import {
  EMPTY_QUEUES,
  IDLE_BUDGET,
  LIVE_WORKER,
  TEST_PASSWORD,
} from "./helpers.js";

/**
 * `/health` against the real Postgres and Redis of `infra/docker-compose.yml`.
 * Read-only on purpose: this file must never touch the data of the test
 * database, it only proves that the probes speak to live services and that a
 * dead one is reported quickly instead of hanging.
 *
 * The live clients come from `helpers.int.ts` rather than from `createDb`
 * and `createRequestRedis` here: the run is already behind the entry check of the
 * preset, and `openTestDb`/`openTestRedis` check their URL once more, so the
 * next integration file of the api - written by copying this one - inherits
 * the guard instead of a way around it.
 */

/** Nothing listens here - a refused connection, not a slow one. */
const CLOSED_REDIS_URL = "redis://127.0.0.1:6399";

/**
 * Upper bound for the whole request when a dependency is unreachable. Well
 * under the probe deadline on purpose: the client is supposed to give up on
 * its own, and a run that only finishes because the deadline fired would mean
 * the fast-failure options are gone.
 */
const FAST_FAILURE_MS = 1_000;

let started: Array<{ app: AppInstance; redis: Redis; close(): Promise<void> }> =
  [];

function startApp(redis: Redis): {
  app: AppInstance;
  redis: Redis;
  errors: Error[];
} {
  const db = openTestDb();
  const errors: Error[] = [];
  redis.on("error", (err: Error) => errors.push(err));

  const app = buildApp(
    {
      health: createHealthProbes({ db, redis }),
      buildInfo: { version: null, commit: null },
      // `/health` is what this file is about; the sections of `/system/status`
      // answer from fixtures so that a Redis this test kills on purpose does
      // not fail a route nobody here calls.
      queues: { collect: async () => EMPTY_QUEUES },
      worker: { read: async () => LIVE_WORKER },
      budget: { collect: async () => IDLE_BUDGET },
    },
    { adminPassword: TEST_PASSWORD, logger: false },
  );

  started.push({
    app,
    redis,
    close: async () => {
      await app.close();
      await closeDb(db);
      redis.disconnect();
    },
  });

  return { app, redis, errors };
}

afterEach(async () => {
  const running = started;
  started = [];
  for (const entry of running) {
    await entry.close();
  }
});

describe("GET /health against live services", () => {
  it("answers 200 while Postgres and Redis are up", async () => {
    const { app, redis, errors } = startApp(openTestRedis());
    await app.ready();
    await whenReady(redis);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(JSON.parse(res.payload))).toEqual({
      status: "ok",
    });
    // A client that is up has nothing to report.
    expect(errors).toEqual([]);
  });

  it("reports a dead Redis quickly instead of waiting on retries", async () => {
    // The client defaults would queue the ping offline and reconnect forever,
    // so this case is the proof that `enableOfflineQueue` and the timeouts of
    // `createRequestRedis` hold on a real socket.
    const { app, errors } = startApp(
      createRequestRedis(CLOSED_REDIS_URL, {
        commandTimeoutMs: DEPENDENCY_TIMEOUT_MS,
      }),
    );
    await app.ready();

    const startedAt = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    const elapsed = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(JSON.parse(res.payload))).toEqual({
      status: "degraded",
    });
    expect(elapsed).toBeLessThan(FAST_FAILURE_MS);
    // The reason is the refused socket - a connection failure by its code,
    // not whatever else the client might have run into.
    expect(errors).not.toHaveLength(0);
    expect(errors.map((err) => connectionFailure(err))).toEqual(
      errors.map(() => "unreachable"),
    );
    expect(errors.map((err) => errorCode(err))).toContain("ECONNREFUSED");
  });
});
