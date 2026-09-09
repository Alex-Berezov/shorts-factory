import { env } from "@sf/config";
import { closeDb, createDb } from "@sf/db";
import { buildApp } from "./app.js";
import { createHealthProbes } from "./lib/health.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { closeRedis, createRedis } from "./lib/redis.js";
import { createShutdownHandler } from "./lib/shutdown.js";

/**
 * REST API entry point: reads the configuration, owns the connections and the
 * socket, and hands everything else to `buildApp`. Route modules are
 * registered per epic in `src/routes/index.ts`:
 *   /radar/*        E1   tracked channels, signals
 *   /intel/*        E2   trigger analysis, read DNA
 *   /inbox/*        E3   idea cards, approve/reject/later
 *   /research/*     E4   briefs
 *   /scripts/*      E5
 *   /production/*   E6
 *   /analytics/*    E7   + /oauth/google/* callbacks
 *   /experiments/*  E8
 *   /localization/* E9-E10
 *   /publishing/*   E11
 *   /system/*       E13  queues, quota, budget
 */
const db = createDb(env.DATABASE_URL);
// The client survives a Redis that is down on its own (`createRedis` subscribes
// to `error` itself); this callback only decides where such a failure is
// written, and it can only be the app logger, which exists a few lines below.
let logRedisError: (err: Error) => void = () => {};
const redis = createRedis(env.REDIS_URL, {
  onError: (err) => {
    logRedisError(err);
  },
});

const app = buildApp(
  {
    health: createHealthProbes({ db, redis }),
    buildInfo: {
      version: env.APP_VERSION ?? null,
      commit: env.GIT_COMMIT ?? null,
    },
  },
  { adminPassword: env.ADMIN_PASSWORD, logger: buildLoggerOptions(env) },
);

logRedisError = (err: Error) => {
  app.log.error({ err }, "redis client error");
};

const shutdown = createShutdownHandler({
  app,
  db: { close: () => closeDb(db) },
  redis: { close: () => closeRedis(redis) },
  log: app.log,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error({ err }, "failed to start the api");
  process.exit(1);
});
