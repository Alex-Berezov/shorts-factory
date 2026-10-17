import { env } from "@sf/config";
import type { QueueName } from "@sf/core";
import { suiteRedisUrl } from "@sf/db/test-support/stack-guard";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createRedis } from "../src/lib/redis.js";

export { openTestDb } from "@sf/db/test-support/fixture";

/**
 * Shared setup for the integration tests of the api.
 *
 * Everything this suite does to the stack is destructive - rows deleted from
 * `api_usage_log`, a spend fixture written into it, the heartbeat key
 * overwritten, a queue paused - so the stack is checked before the first file
 * of the run, by the entry check the preset gives this run
 * (`entryCheck: "migrated-stack"` in `vitest.int.config.ts`): both URLs of
 * `.env.test`, then that `@sf/db`'s integration run has migrated the
 * database (this suite does not migrate it). A file that forgets this module
 * is still behind it. The connections are opened here all the same -
 * `openTestDb` and `openTestRedis` check their URL once more - so that a
 * file written by copying another inherits the guard, not a way around it.
 *
 * The Redis database is the api's own (`suiteRedisUrl(…, "api")`): this suite
 * pauses a queue to prove the page can tell a paused queue from an idle one,
 * and that pause must not reach the queues the worker suite takes jobs from.
 * Postgres stays shared (one migrated schema), and the two suites keep apart
 * there by provider: the worker spends `gemini`, this one `youtube_data`.
 */

/** Connection for an integration file of the api; the caller closes it. */
export function openTestRedis(): Redis {
  return createRedis(suiteRedisUrl(env.REDIS_URL, "api"));
}

/**
 * A queue for a fixture to act on, opened the way the api itself opens one:
 * with `skipMetasUpdate`, so that opening it writes nothing into
 * `bull:<name>:meta` - the write the page is forbidden (ADR-0003). The caller
 * closes it.
 */
export function openTestQueue(name: QueueName, connection: Redis): Queue {
  return new Queue(name, { connection, skipMetasUpdate: true });
}
