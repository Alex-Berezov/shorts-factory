import { env } from "@sf/config";
import { closeDb, createDb } from "@sf/db";
import { pino } from "pino";
import { bootstrap } from "./bootstrap.js";
import { buildWorkerLoggerOptions } from "./lib/logger.js";
import { closeRedis, createRedis } from "./lib/redis.js";
import { startWorkerRuntime } from "./runtime.js";

/**
 * Worker entry point: reads the configuration, owns the connections and hands
 * the order of everything else to `bootstrap`. Job processors are registered
 * per epic in `src/jobs/index.ts` - E0 runs `system.heartbeat` and
 * `system.smoke`, every other queue of the registry waits for the epic that
 * fills it in.
 */
const log = pino(buildWorkerLoggerOptions(env));
const db = createDb(env.DATABASE_URL);

// The logger is what turns on the health reporting of the client: an outage
// at a level that fades, a reconnect that says the next one is news again.
const redis = createRedis(env.REDIS_URL, { log });

await bootstrap({
  log,
  start: () => startWorkerRuntime({ env, db, redis, log }),
  connections: [
    { name: "redis", close: () => closeRedis(redis) },
    { name: "db", close: () => closeDb(db) },
  ],
});
