import { assertLocalHost } from "@sf/db/test/local-host-guard.js";

/**
 * The guard in front of the destructive steps of the worker integration run.
 *
 * These tests do not only read: they `obliterate` queues (jobs, schedulers and
 * the paused flag with them), delete rows from `api_usage_log` and overwrite
 * `app_setting.queues.enabled` - the row an operator switches paid queues off
 * with. Against anything but the local Compose that is data loss, and a
 * `.env.test` pointing through a tunnel is a scenario the tech debt list
 * already carries. `@sf/db` guards its own `DROP SCHEMA` the same way, and
 * `assertLocalHost` is imported from there rather than copied: two guards
 * drift, and the weaker one is the one that gets used.
 *
 * Imports nothing but that guard - no parsed environment, no connection - so
 * `pnpm test` checks it on every run, not only with Compose up.
 */

/** The only database the worker integration tests may write to. */
export const TEST_DATABASE = "shorts_factory_test";
/** The only Redis database they may wipe (`.env.test`: `redis://…:6389/1`). */
export const TEST_REDIS_DATABASE = "1";

/** The database or Redis database a URL points at, without the leading slash. */
function pathOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

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
  assertLocalHost(databaseUrl);
  assertLocalHost(redisUrl);

  const database = pathOf(databaseUrl);
  if (database !== TEST_DATABASE) {
    throw new Error(
      `refusing to write to database "${database}": the worker integration tests only run against "${TEST_DATABASE}"`,
    );
  }

  const redisDatabase = pathOf(redisUrl);
  if (redisDatabase !== TEST_REDIS_DATABASE) {
    throw new Error(
      `refusing to wipe queues in redis database "${redisDatabase}": the worker integration tests only run against database ${TEST_REDIS_DATABASE}`,
    );
  }
}
