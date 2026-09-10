import type { QueueName } from "@sf/core";
import type { JobsOptions } from "bullmq";

/**
 * How a job of a given queue is run: the retry policy every job inherits and
 * the concurrency a queue is allowed. No registry lives here - the names come
 * from `QUEUE_NAMES` in `@sf/core`, the processors from `src/jobs/index.ts`
 * and the schedules from `src/schedules.ts`, and none of the three is repeated
 * here: a second list would drift from the seed of `app_setting.queues.enabled`
 * silently.
 */

/**
 * Retry policy every job inherits (§4 of the System Design). Five attempts
 * with an exponential backoff from five seconds cover the failure this exists
 * for - a provider that is briefly unavailable - without holding a slot for an
 * error that will not fix itself.
 *
 * `removeOnComplete`/`removeOnFail` keep the last thousand records per queue:
 * enough for an operator to see what happened, bounded enough that Redis does
 * not grow forever. The cost is that deduplication by `jobId` only lasts as
 * long as the record does - once it is evicted the same id can be enqueued
 * again, which is why a handler still has to be safe to run twice.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 1_000 },
};

/**
 * Upper bound on how many jobs of one queue may run at once, whatever
 * `WORKER_CONCURRENCY` says.
 *
 * `WORKER_CONCURRENCY` is a per-queue number (docs/DECISIONS.md, 06.09.2026),
 * so with a `Worker` per queue the process can hold that many jobs times the
 * number of queues. For the fan-out queues below every one of those slots is a
 * paid external call, and a batch of them leaves before a daily cap has a
 * chance to notice (docs/TECH_DEBT.md, 06.09.2026). The cap is a resource
 * guard, not a budget one: the budget guard of E0-09 is what refuses to spend.
 */
const PAID_FANOUT_CAP = 2;

/**
 * The queues whose every job costs money. Written out rather than derived: a
 * new paid queue must be a decision made here, not something a naming rule
 * quietly picks up or misses.
 */
const CONCURRENCY_CAPS: Partial<Record<QueueName, number>> = {
  "intel.analyze-video": PAID_FANOUT_CAP,
  "research.run": PAID_FANOUT_CAP,
  "script.generate": PAID_FANOUT_CAP,
  "tts.generate": PAID_FANOUT_CAP,
  "tts.bakeoff": PAID_FANOUT_CAP,
};

/**
 * How many jobs of `queue` may run at once: the configured concurrency, capped
 * for the paid queues. Lowering `WORKER_CONCURRENCY` still lowers everything -
 * the cap is a ceiling, not a floor.
 */
export function queueConcurrency(
  queue: QueueName,
  workerConcurrency: number,
): number {
  const cap = CONCURRENCY_CAPS[queue];
  return cap === undefined
    ? workerConcurrency
    : Math.min(workerConcurrency, cap);
}
