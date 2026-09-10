import { env } from "@sf/config";
import { QueueEvents } from "bullmq";
import { pino } from "pino";
import { systemSmokeJob } from "../jobs/system-smoke.js";
import { buildWorkerLoggerOptions } from "../lib/logger.js";
import { createQueueFactory } from "../lib/queues.js";
import { closeRedis, createRedis } from "../lib/redis.js";
import { runSmoke, settleWithin } from "./smoke-run.js";

/**
 * `pnpm --filter @sf/worker smoke`: puts one `system.smoke` job on the queue
 * and waits for the running worker to finish it. The acceptance criterion of
 * E0 in one command - the job goes through Redis, runs in the other process
 * and leaves a row in `api_usage_log`.
 *
 * This process does not run the job itself: the point is to prove that the
 * worker does. Everything that decides the verdict lives in `smoke-run.ts`;
 * here are only the connections and the exit code.
 */
/** The connections get this long to go away; the verdict is already out. */
const CLOSE_DEADLINE_MS = 5_000;

const log = pino(buildWorkerLoggerOptions(env));

// Reported, not swallowed: a Redis that refuses the connection is the most
// likely reason this command has nothing to say, and the client keeps the
// commands queued instead of failing them (see `lib/redis.ts`). The logger is
// the whole wiring - the same one the worker entry point gets, rather than a
// second copy of it that forgets the reconnect.
const redis = createRedis(env.REDIS_URL, { log });
// Its own connection: `QueueEvents` blocks on the stream, and a blocked client
// could not add the job below.
const eventsConnection = createRedis(env.REDIS_URL, { log });
const queues = createQueueFactory(redis);
const queue = queues.get("system.smoke");
const events = new QueueEvents("system.smoke", {
  connection: eventsConnection,
});

const outcome = await runSmoke({
  events,
  queue,
  enqueue: () => systemSmokeJob.enqueue(queue, { requestedAtMs: Date.now() }),
  log,
});

// The verdict is printed before anything is closed. Closing talks to the same
// Redis the run may have just failed to reach, and `quit` on a client with an
// offline queue waits for a socket that never comes: with the order the other
// way round a dead stack swallowed both the reason and the exit code.
if (outcome.ok) {
  log.info("smoke job completed");
} else {
  log.error({ reason: outcome.reason }, "smoke job did not complete");
}

const closed = await settleWithin(
  (async () => {
    await events.close();
    await queues.close();
    await closeRedis(redis);
    await closeRedis(eventsConnection);
    return true;
  })().catch(() => false),
  CLOSE_DEADLINE_MS,
  false,
);
if (!closed) {
  log.warn(
    { timeoutMs: CLOSE_DEADLINE_MS },
    "connections did not close in time",
  );
}

process.exit(outcome.ok ? 0 : 1);
