import {
  assertLocalRedisDatabase,
  assertLocalTestDatabase,
} from "@sf/db/test/local-host-guard.js";

/**
 * The guard in front of the destructive steps of the api integration run.
 *
 * This suite is not a reader either: it deletes rows from `api_usage_log`,
 * writes a `youtube_data` spend fixture into the same table, overwrites the
 * heartbeat key and pauses a queue. Against a `.env.test` that names a
 * development or a remote stack (CI, the VPS of E0-11) the delete takes rows
 * of a real spend journal and the fixture adds units that were never spent -
 * the cap would then be guarded against a number nobody can explain.
 *
 * The two checks come from `@sf/db` and are the same ones the worker fixture
 * stands behind, host and database name both: the development stack listens on
 * the same machine, so a host check alone lets `shorts_factory` through, and a
 * remote host can hold a database called `shorts_factory_test`.
 * (`resetTestDatabase` guards its `DROP SCHEMA` differently - see the docblock
 * of `@sf/db/test/local-host-guard.ts`.)
 *
 * Imports nothing but those guards - no parsed environment, no connection - so
 * `pnpm test` checks it on every run, not only with Compose up.
 */

/**
 * The Redis database this suite owns.
 *
 * Not database 1, which `.env.test` names and the worker integration tests
 * drive. The two suites are separate packages, so `turbo run test:int` starts
 * them at the same time, and they were sharing one BullMQ namespace: this one
 * pauses a queue to prove the page can tell a paused queue from an idle one,
 * while the worker is running jobs through the same queue in the same Redis,
 * and the worker resumes whatever the queue switches say a second later.
 * Neither suite is wrong and neither can be weakened, so they are given a
 * namespace each - which is also what makes a run here reproducible instead of
 * dependent on how far along the other suite is.
 *
 * Postgres stays shared (one migrated schema), and the two suites keep apart
 * there by provider: the worker spends `gemini`, this one spends
 * `youtube_data`, and neither deletes the rows of the other.
 */
const API_TEST_REDIS_DATABASE = "2";

/**
 * The Redis database `.env.test` names, and the only one this suite accepts as
 * the description of the stack it was pointed at (`redis://…:6389/1`).
 *
 * The check happens on this number, not on the one above, because the derived
 * URL carries a database this module has just written into it: a guard reading
 * its own assignment cannot refuse anything. So the server is identified by
 * what the environment says - the Compose test stack, which names database 1 -
 * and the suite then works one database over, in the namespace it owns.
 */
const ENV_TEST_REDIS_DATABASE = "1";

/** The same server as `.env.test`, in the database this suite owns. */
export function apiTestRedisUrl(redisUrl: string): string {
  const url = new URL(redisUrl);
  url.pathname = `/${API_TEST_REDIS_DATABASE}`;
  return url.toString();
}

/**
 * Refuses anything but the local Postgres of `infra/docker-compose.yml` and
 * the local Redis it stands next to.
 *
 * The Redis URL checked is the raw one from the environment, exactly as the
 * worker fixture checks it: a `.env.test` naming another server - or another
 * Redis on this machine, the one a development stack keeps its real queues in
 * - is refused before a single queue is opened there, and the database this
 * suite works in is derived from a URL that has already been vouched for.
 */
export function assertApiTestStack(
  databaseUrl: string,
  redisUrl: string,
): void {
  assertLocalTestDatabase(databaseUrl);
  assertLocalRedisDatabase(redisUrl, ENV_TEST_REDIS_DATABASE);
}
