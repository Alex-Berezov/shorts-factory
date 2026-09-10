import { env } from "@sf/config";
import { QUEUE_NAMES, QUEUE_SWITCHES_KEY, type QueueName } from "@sf/core";
import { type Db, appSettingRepo, createDb } from "@sf/db";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { pino } from "pino";
import { createRedis } from "../src/lib/redis.js";
import { assertLocalTestStack } from "./local-stack-guard.js";

/**
 * Shared setup for the worker integration tests.
 *
 * The test Redis is `db 1` of the local Compose (`.env.test`), which the api
 * integration tests use as well, and BullMQ keys survive a run that crashed.
 * So every file wipes the queues it uses both before and after itself: a
 * leftover job from a previous run would make the next one green for the wrong
 * reason - or red for one.
 *
 * Everything below is destructive - `obliterate`, deletes from
 * `api_usage_log`, an overwrite of the switch row - so the stack is checked
 * before anything else in this module runs, and it is checked here because
 * every integration file of this app goes through it (including the ones that
 * write their own SQL). A `.env.test` pointing at a tunnelled host or at the
 * development database is refused rather than obeyed.
 */
assertLocalTestStack(env.DATABASE_URL, env.REDIS_URL);

/** Connection for a test file; the caller closes it. */
export function openTestRedis(): Redis {
  return createRedis(env.REDIS_URL);
}

/** Database handle for a test file; the caller closes it with `closeDb`. */
export function openTestDb(): Db {
  return createDb(env.DATABASE_URL, { max: 2 });
}

/** Logger that keeps the test output readable but still exists. */
export function testLogger() {
  return pino({ level: "silent" });
}

/**
 * Removes every trace of the given queues from Redis - jobs, schedulers, the
 * paused flag. `force` because a queue may still hold jobs a previous run
 * abandoned, and that is exactly what has to go.
 */
export async function obliterateQueues(
  connection: Redis,
  names: readonly QueueName[],
): Promise<void> {
  for (const name of names) {
    const queue = new Queue(name, { connection });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}

/**
 * Writes the switch row the way `pnpm db:seed` would, plus the overrides a
 * test needs. Written rather than assumed: the integration tests of `@sf/db`
 * reset the same database and leave whatever their last case wrote, and a
 * worker refuses to start without this row.
 */
export async function seedQueueSwitches(
  db: Db,
  overrides: Record<string, boolean> = {},
): Promise<void> {
  await appSettingRepo.set(db, QUEUE_SWITCHES_KEY, {
    ...Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
    ...overrides,
  });
}

/** Drops the usage rows a smoke run leaves behind. */
export async function deleteSmokeUsage(db: Db): Promise<void> {
  await db.$client`
    delete from api_usage_log where provider = 'system' and operation = 'smoke'
  `;
}

/** The usage row a smoke job wrote, by the id of that job. */
export async function findUsageRow(
  db: Db,
  jobId: string,
): Promise<
  { provider: string; operation: string; units: number | null } | undefined
> {
  const rows = await db.$client<
    { provider: string; operation: string; units: number | null }[]
  >`
    select provider, operation, units from api_usage_log where job_id = ${jobId}
  `;
  return rows[0];
}

/**
 * Waits until `probe` answers something other than `undefined`, or gives up.
 * Polling rather than an event: what these tests assert is the state that is
 * left behind, and an event that fired before the listener was attached would
 * make the assertion flaky rather than wrong.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${options.what ?? "a condition"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
