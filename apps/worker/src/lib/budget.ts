import type { Limits } from "@sf/config";
import {
  type BudgetCache,
  type BudgetGuard,
  type Db,
  createBudgetGuard,
} from "@sf/db";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

/**
 * How long a cache command is given before it counts as a miss.
 *
 * The number is small because what it replaces is a database aggregate over
 * one index - a hundred times cheaper than the outage it is protecting against
 * - and because it sits in front of a job that is holding a lock.
 */
const BUDGET_CACHE_TIMEOUT_MS = 500;

/** What a cache command that ran out of its own time is reported as. */
export class BudgetCacheTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`budget cache ${command} did not answer in ${timeoutMs}ms`);
    this.name = "BudgetCacheTimeoutError";
  }
}

/**
 * Runs one cache command under a deadline of its own.
 *
 * Not a refinement: it is the only thing that makes "a cache that is down is a
 * miss" true on the client this process actually has. The worker connection is
 * built for BullMQ - `maxRetriesPerRequest: null` with the offline queue on
 * (`lib/redis.ts`) - so a `GET` issued while Redis is unreachable is neither
 * answered nor refused; it waits in the offline queue for a reconnect that may
 * never come. The guard's fallback catches a rejection, so without a deadline
 * here the fallback is unreachable and `ctx.budget.assert` hangs for the whole
 * outage, holding the job it was asked about until the lock is lost and BullMQ
 * hands the job to someone else.
 *
 * The timer is unreferenced: it must not be the reason the process stays up
 * during a shutdown.
 *
 * One of five copies of "a promise under a deadline" across the two apps
 * (`apps/api/src/lib/deadline.ts` and the `drain` of `lib/queue-stats.ts`,
 * `cli/smoke-run.ts`, `lib/shutdown.ts`), and they have already drifted on
 * `unref`. Merging them is a change to both processes at once, so it is a line
 * in docs/TECH_DEBT.md (13.09.2026, E0-12) rather than a merge attempted from
 * whichever of the five a task happens to touch.
 */
async function withTimeout<T>(
  command: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BudgetCacheTimeoutError(command, timeoutMs)),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RedisBudgetCacheOptions {
  /** Overridable for tests; the default is `BUDGET_CACHE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The guard's cache port over the Redis connection of this process.
 *
 * It is an adapter and nothing more: `@sf/db` may not depend on ioredis
 * (ADR-0002), and this is the whole of what the guard asks for - a string in,
 * a string out, an expiry. Failures are not swallowed here: the guard decides
 * what a cache that is down means, and its answer is "count from the database
 * and log it", not "refuse the job".
 *
 * Which is why every command has a deadline: a failure the guard never hears
 * about is not a failure it can decide anything about (see `withTimeout`).
 */
export function createRedisBudgetCache(
  redis: Redis,
  options: RedisBudgetCacheOptions = {},
): BudgetCache {
  const timeoutMs = options.timeoutMs ?? BUDGET_CACHE_TIMEOUT_MS;

  return {
    async get(key: string): Promise<string | null> {
      return withTimeout("get", timeoutMs, () => redis.get(key));
    },
    async set(key: string, value: string, ttlSec: number): Promise<void> {
      await withTimeout("set", timeoutMs, () =>
        redis.set(key, value, "EX", ttlSec),
      );
    },
  };
}

export interface WorkerBudgetGuardOptions {
  db: Db;
  redis: Redis;
  /** The caps of this deployment (`@sf/config`). */
  limits: Limits;
  log: Logger;
}

/**
 * The budget guard of the worker: the shared one from `@sf/db`, with the caps
 * of this deployment and the Redis of this process behind it.
 *
 * Built once per process and handed to every job through `JobRuntimeDeps`. One
 * instance, because the cache it uses is shared state anyway and a guard per
 * job would only multiply the round trips that the cache exists to avoid.
 */
export function createWorkerBudgetGuard(
  options: WorkerBudgetGuardOptions,
): BudgetGuard {
  return createBudgetGuard({
    db: options.db,
    limits: options.limits,
    cache: createRedisBudgetCache(options.redis),
    log: options.log,
  });
}
