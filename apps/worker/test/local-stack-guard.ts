import {
  assertLocalRedisDatabase,
  assertLocalTestDatabase,
} from "@sf/db/test/local-host-guard.js";

/**
 * The guard in front of the destructive steps of the worker integration run.
 *
 * These tests do not only read: they `obliterate` queues (jobs, schedulers and
 * the paused flag with them), delete rows from `api_usage_log` and overwrite
 * `app_setting.queues.enabled` - the row an operator switches paid queues off
 * with. Against anything but the local Compose that is data loss, and a
 * `.env.test` pointing through a tunnel is a scenario the tech debt list
 * already carries. The checks themselves come from `@sf/db` rather than being
 * copied here: the api fixture stands behind the same two, and two guards
 * drift - the weaker one being the one that gets used. (`resetTestDatabase`
 * guards its `DROP SCHEMA` differently - see the docblock of
 * `@sf/db/test/local-host-guard.ts`.)
 *
 * Imports nothing but those guards - no parsed environment, no connection - so
 * `pnpm test` checks it on every run, not only with Compose up.
 */

/** The only Redis database they may wipe (`.env.test`: `redis://…:6389/1`). */
const TEST_REDIS_DATABASE = "1";

/**
 * Refuses anything but the local Postgres and the local Redis of
 * `infra/docker-compose.yml`, by host and by the database inside it: the
 * development stack listens on the same machine as the test one, and running
 * these tests against `shorts_factory` (or Redis database 0) would take the
 * queues and the usage rows of a worker that is doing real work.
 */
export function assertLocalTestStack(
  databaseUrl: string,
  redisUrl: string,
): void {
  assertLocalTestDatabase(databaseUrl);
  assertLocalRedisDatabase(redisUrl, TEST_REDIS_DATABASE);
}
