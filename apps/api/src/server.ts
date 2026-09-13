import { env, limits } from "@sf/config";
import { closeDb, createDb } from "@sf/db";
import { buildApp } from "./app.js";
import { createBudgetProbe } from "./lib/budget.js";
import { createHealthProbes } from "./lib/health.js";
import { createWorkerProbe } from "./lib/heartbeat.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { createQueueStats } from "./lib/queue-stats.js";
import { closeRedis, createRedis } from "./lib/redis.js";
import { createShutdownHandler } from "./lib/shutdown.js";

/**
 * REST API entry point: reads the configuration, owns the connections and the
 * socket, and hands everything else to `buildApp`. Which modules exist is not
 * listed here - the registry in `src/routes/index.ts` is the map, and a copy
 * of it in this docblock would be a guide that stops being true the first time
 * someone adds a module to the registry alone.
 */
const db = createDb(env.DATABASE_URL);
// The client survives a Redis that is down on its own (`createRedis` subscribes
// to `error` itself); this callback only decides where such a failure is
// written, and it can only be the app logger, which exists a few lines below.
let logRedisError: (err: Error) => void = () => {};
// Same reason, for the `Queue` objects opened below: without a listener an
// ioredis failure reaches the process as an unhandled `EventEmitter` error and
// takes the api down with it.
let logQueueError: (queue: string, err: Error) => void = () => {};
const redis = createRedis(env.REDIS_URL, {
  onError: (err) => {
    logRedisError(err);
  },
});

// The `Queue` objects live for the process, not for the request: each one is
// a set of listeners and a key of its own, and opening 29 of them per call to
// `/system/status` would make the page the most expensive route of the api.
const queueStats = createQueueStats({
  connection: redis,
  onError: (queue, err) => {
    logQueueError(queue, err);
  },
});

const app = buildApp(
  {
    health: createHealthProbes({ db, redis }),
    buildInfo: {
      version: env.APP_VERSION ?? null,
      commit: env.GIT_COMMIT ?? null,
    },
    queues: queueStats,
    worker: createWorkerProbe({ redis }),
    // No cache here on purpose: the page has to show a spend row written a
    // moment ago, and a cached total would answer for the minute before it.
    budget: createBudgetProbe({ db, limits }),
  },
  { adminPassword: env.ADMIN_PASSWORD, logger: buildLoggerOptions(env) },
);

logQueueError = (queue: string, err: Error) => {
  app.log.error({ queue, err }, "queue error");
};

logRedisError = (err: Error) => {
  app.log.error({ err }, "redis client error");
};

const shutdown = createShutdownHandler({
  app,
  db: { close: () => closeDb(db) },
  // Before Redis: the queues are closed through the connection they share
  // with it, and a client that is already gone leaves them hanging.
  queues: { close: () => queueStats.close() },
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
