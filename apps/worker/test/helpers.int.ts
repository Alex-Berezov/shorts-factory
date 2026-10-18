import { env } from "@sf/config";
import { QUEUE_SWITCHES_KEY, type QueueName } from "@sf/core";
import { type Db, appSettingRepo } from "@sf/db";
import { defaultQueueSwitches } from "@sf/db/test-support/fixture";
import { suiteRedisUrl } from "@sf/db/test-support/stack-guard";
import { type QueueFactory, createQueueRedis } from "@sf/runtime";
import { silentLogger } from "@sf/runtime/test-support/recording-logger";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createJobQueueFactory } from "../src/lib/job-policy.js";

export { openTestDb } from "@sf/db/test-support/fixture";

/**
 * Shared setup for the worker integration tests.
 *
 * The test Redis is the database `.env.test` names, which this suite has to
 * itself - the integration tests of the api work in a database of their own
 * exactly so that a pause of theirs could not reach a queue this one is
 * taking jobs from (both numbers: `TEST_REDIS_DATABASE_OF` in
 * `@sf/db/test-support/stack-guard`). BullMQ keys still survive a run that
 * crashed, so every file wipes the queues it uses both before and after
 * itself: a leftover job from a previous run would make the next one green
 * for the wrong reason - or red for one.
 *
 * Everything below is destructive - `obliterate`, deletes from
 * `api_usage_log`, an overwrite of the switch row - so the stack is checked
 * before the first file of the run, by the entry check the preset gives this
 * run (`entryCheck: "migrated-stack"` in `vitest.int.config.ts`): both URLs of
 * `.env.test` - Redis too, which the processes this suite forks read as is -
 * then that `@sf/db`'s integration run has migrated the database (this suite
 * does not migrate it). A file that forgets this module is still behind it;
 * the connections are opened here all the same, and check their URL once
 * more, so that a file written by copying another inherits the guard.
 */

/** Connection for a test file; the caller closes it. */
export function openTestRedis(): Redis {
  return createQueueRedis(suiteRedisUrl(env.REDIS_URL, "worker"));
}

/**
 * The queue factory the runtime builds for itself (`startWorkerRuntime`):
 * the job policy of this app, written to by nobody but the factory's own
 * listener, which a case about something else does not need to hear.
 */
export function workerQueueFactory(connection: Redis): QueueFactory {
  return createJobQueueFactory(connection, silentLogger());
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
 * Writes the switch row the way `pnpm db:seed` would - from the same
 * `defaultQueueSwitches` - plus the overrides a test needs. Written rather
 * than assumed: the integration tests of `@sf/db` reset the same database and
 * leave whatever their last case wrote, and a worker refuses to start without
 * this row.
 */
export async function seedQueueSwitches(
  db: Db,
  overrides: Record<string, boolean> = {},
): Promise<void> {
  await appSettingRepo.set(db, QUEUE_SWITCHES_KEY, {
    ...defaultQueueSwitches(),
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
