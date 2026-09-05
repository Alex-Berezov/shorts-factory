import { env } from "@sf/config";
import { QUEUES } from "./queues.js";

/**
 * Worker entry point.
 * TODO(E0): BullMQ Worker registration per queue, repeatable (cron) jobs,
 * DLQ wiring, graceful shutdown, per-job cost logging to api_usage_log.
 *
 * Job requirements (all queues):
 *  - idempotent (deterministic jobId),
 *  - exponential backoff retries,
 *  - budget/quota guard before external calls.
 */
console.log(`[worker] env=${env.NODE_ENV} queues=${Object.values(QUEUES).length} registered (stub)`);
