import { env } from "@sf/config";
import { createDb } from "@sf/db";
import { buildLoggerOptions, createQueueRedis } from "@sf/runtime";
import { pino } from "pino";
import { bootstrap, connectionStages } from "./bootstrap.js";
import { startWorkerRuntime } from "./runtime.js";

/**
 * Worker entry point: reads the configuration, owns the connections and hands
 * the order of everything else to `bootstrap`. Job processors are registered
 * per epic in `src/jobs/index.ts` - E0 runs `system.heartbeat` and
 * `system.smoke`, every other queue of the registry waits for the epic that
 * fills it in.
 */
const log = pino(buildLoggerOptions(env));
const db = createDb(env.DATABASE_URL);

// The logger is what turns on the health reporting of the client: an outage
// at a level that fades, a reconnect that says the next one is news again.
const redis = createQueueRedis(env.REDIS_URL, { log });

await bootstrap({
  log,
  start: () => startWorkerRuntime({ env, db, redis, log }),
  connections: connectionStages(redis, db),
});
