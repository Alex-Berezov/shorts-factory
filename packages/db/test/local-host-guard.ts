/**
 * The guard that stands in front of the destructive steps of an integration
 * run - the deletes and `obliterate` of the worker fixture
 * (`apps/worker/test/local-stack-guard.ts`) and the deletes of the api fixture
 * (`apps/api/test/local-stack-guard.ts`). Both import this module rather than
 * keeping a copy: two guards drift, and the one that gets used is the weaker
 * one.
 *
 * `resetTestDatabase` (`helpers.int.ts`) is the exception, and knowingly so:
 * it takes `assertLocalHost` from here but checks the name against a literal
 * of its own, asking the server which database it is really connected to
 * rather than trusting the URL it was given - it drops schemas. That the two
 * literals must be kept equal is a line in docs/TECH_DEBT.md.
 *
 * It lives on its own and imports nothing - no database, no parsed
 * environment - so that `pnpm test` checks it on every run. Inside the
 * integration fixture it would only be exercised with Compose up, and the
 * `test:int` gate is not on yet: removing the guard would then reach a commit
 * green.
 */

/** Integration tests only ever touch a service on this machine. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** The only Postgres database an integration run of any app may write to. */
export const TEST_DATABASE = "shorts_factory_test";

/** The database a connection URL names, without the leading slash. */
function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/**
 * Refuses a connection URL pointing anywhere but this machine. A remote host
 * can hold a database named `shorts_factory_test` - or a Redis with a database
 * 1 - too (CI, a future VPS), and the name alone would let the reset drop
 * schemas there, or a test wipe queues that hold real jobs.
 */
export function assertLocalHost(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `refusing to touch data on host "${host}": integration tests only run against services on this machine`,
    );
  }
}

/**
 * Refuses a Postgres URL that is not the local test database.
 *
 * Host and name, because either alone lets the destructive half of a suite
 * through: the development stack listens on the same machine as the test one,
 * so `shorts_factory` next door is one character away, and a remote host can
 * hold a database named `shorts_factory_test` too. What the suites do to it -
 * `DROP SCHEMA`, `delete from api_usage_log` - is not something the second
 * look at a `.env.test` can undo.
 */
export function assertLocalTestDatabase(databaseUrl: string): void {
  assertLocalHost(databaseUrl);
  const database = databaseOf(databaseUrl);
  if (database !== TEST_DATABASE) {
    throw new Error(
      `refusing to write to database "${database}": integration tests only run against "${TEST_DATABASE}"`,
    );
  }
}

/**
 * Refuses a Redis URL that is not the local database this suite owns.
 *
 * Which number that is differs per suite (the worker drives database 1, the
 * api database 2), so it is an argument; that it is never database 0 - the one
 * a running worker keeps its queues in - is the part that matters.
 */
export function assertLocalRedisDatabase(
  redisUrl: string,
  database: string,
): void {
  assertLocalHost(redisUrl);
  const actual = databaseOf(redisUrl);
  if (actual !== database) {
    throw new Error(
      `refusing to touch queues in redis database "${actual}": these integration tests only run against database ${database}`,
    );
  }
}
