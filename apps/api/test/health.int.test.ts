import { env } from "@sf/config";
import { HealthResponseSchema } from "@sf/contracts";
import { closeDb, createDb } from "@sf/db";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { type AppInstance, buildApp } from "../src/app.js";
import { createHealthProbes } from "../src/lib/health.js";
import { createRedis } from "../src/lib/redis.js";
import { TEST_PASSWORD } from "./helpers.js";

/**
 * `/health` against the real Postgres and Redis of `infra/docker-compose.yml`.
 * Read-only on purpose: this file must never touch the data of the test
 * database, it only proves that the probes speak to live services and that a
 * dead one is reported quickly instead of hanging.
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

/**
 * Resolves once the client has a usable socket. A freshly created client is
 * still connecting, and with the offline queue disabled a ping issued in that
 * window fails - which is the honest answer for `/health`, but not what the
 * "both services are up" case is about.
 */
async function whenReady(redis: Redis): Promise<void> {
  if (redis.status === "ready") {
    return;
  }
  await new Promise<void>((resolve) => {
    redis.once("ready", resolve);
  });
}

function startApp(redisUrl: string): {
  app: AppInstance;
  redis: Redis;
  errors: Error[];
} {
  const db = createDb(env.DATABASE_URL);
  const redis = createRedis(redisUrl);
  const errors: Error[] = [];
  redis.on("error", (err: Error) => errors.push(err));

  const app = buildApp(
    {
      health: createHealthProbes({ db, redis }),
      buildInfo: { version: null, commit: null },
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
    const { app, redis } = startApp(env.REDIS_URL);
    await app.ready();
    await whenReady(redis);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(JSON.parse(res.payload))).toEqual({
      status: "ok",
    });
  });

  it("reports a dead Redis quickly instead of waiting on retries", async () => {
    // The client defaults would queue the ping offline and reconnect forever,
    // so this case is the proof that `enableOfflineQueue` and the timeouts of
    // `createRedis` hold on a real socket.
    const { app } = startApp(CLOSED_REDIS_URL);
    await app.ready();

    const startedAt = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    const elapsed = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(JSON.parse(res.payload))).toEqual({
      status: "degraded",
    });
    expect(elapsed).toBeLessThan(FAST_FAILURE_MS);
  });
});
