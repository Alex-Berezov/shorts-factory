/**
 * The one guard in front of the destructive steps of every integration run:
 * the `DROP SCHEMA` of `resetTestDatabase` (`./fixture.ts`), the deletes from
 * `api_usage_log` and the queue pause of the api suite, the `obliterate` and
 * the switch-row overwrites of the worker suite. All three suites stand behind
 * the same two functions - `assertLocalTestPostgres` and `assertLocalTestRedis`,
 * one per service - so there is no weaker copy to drift to. Every integration
 * run meets them before its first file, in the entry check the preset sets
 * (`./entry-check/`), and again in each helper that opens a connection
 * (docs/adr/0011-vitest-preset-and-test-support.md).
 *
 * What it checks, and nothing more:
 * - host: `localhost`, `127.0.0.1` or `::1`, for both URLs;
 * - port: exactly the ports `infra/docker-compose.yml` publishes the test
 *   stack on, for both URLs - a URL without a port means the default
 *   5432/6379, which on a developer machine is usually another project's
 *   server, and is refused;
 * - scheme: `postgres:`/`postgresql:` for Postgres, `redis:` for Redis;
 * - the host as the driver reads it, not only as `new URL` does: postgres-js
 *   takes the host after the *first* `@`, percent-decodes it and reads a `,`
 *   as a list of hosts, while `new URL` takes the host after the *last* `@`.
 *   A URL with a second `@`, a `,` or a `%` in its host, a backslash, a space
 *   or a fragment is refused before it is parsed, and the host and port
 *   `new URL` found must be, letter for letter, what the driver would dial -
 *   so `sf:sf@db.example.com,x@localhost:5442` cannot pass for local. The
 *   installed drivers, not a version written here, are what this is checked
 *   against: `apps/api/test/stack-guard-drivers.test.ts` (postgres-js and
 *   ioredis on one table of addresses);
 * - no query string on either URL: postgres-js and ioredis read connection
 *   options from it, and a URL that only looks local is still refused;
 * - Postgres database: by the name in the URL here, and by the name the server
 *   reports (`current_database()`) in `emptyTestDatabase` through
 *   `assertTestDatabaseName`;
 * - Redis database: the number `.env.test` names - the description of the
 *   stack a suite was pointed at. The database a suite then works in is
 *   derived from it by `suiteRedisUrl`, from the registry below, and
 *   `suiteRedisUrl` checks the URL it is given before it derives anything.
 *
 * A URL that does not parse is refused without its text: the `TypeError` of
 * `new URL` carries the whole input, password included, into the test output.
 *
 * It imports nothing - no database, no parsed environment - so that
 * `pnpm test` checks it on every run, not only with Compose up.
 */

/**
 * The local test stack: `infra/docker-compose.yml` and `.env.test`. The only
 * place these values are written in code; `packages/db/test/stack-guard.test.ts`
 * holds them equal to `.env.test`.
 */
export const TEST_STACK = {
  hosts: ["localhost", "127.0.0.1", "::1"],
  postgresPort: "5442",
  database: "shorts_factory_test",
  redisPort: "6389",
  envRedisDatabase: "1",
} as const;

/**
 * The Redis database each integration suite works in - one namespace per
 * suite. `turbo run test:int` runs packages one at a time today, but the
 * suites were sharing one BullMQ namespace before, and a pause of a queue in
 * the api suite reached the jobs of the worker suite. The worker keeps the
 * database `.env.test` names: the processes it forks read `REDIS_URL` as is.
 * A new suite adds a line here instead of picking a number.
 */
export const TEST_REDIS_DATABASE_OF = {
  worker: TEST_STACK.envRedisDatabase,
  api: "2",
} as const;

/** An integration suite with a Redis database of its own. */
type TestSuite = keyof typeof TEST_REDIS_DATABASE_OF;

const ENV_TEST = "check .env.test against infra/docker-compose.yml";

/** The schemes each service is reached under; a TLS or any other scheme is refused. */
const SCHEMES = {
  Postgres: ["postgres:", "postgresql:"],
  Redis: ["redis:"],
} as const;

type Service = keyof typeof SCHEMES;

/**
 * Characters the URL standard and the drivers read differently: whitespace
 * and control characters (`new URL` drops a tab, a driver keeps it), a
 * backslash (ioredis parses a WHATWG URL, but an older reader or a proxy may
 * still turn it into a `/` that ends the host), a fragment (postgres-js does
 * not cut the host at `#`).
 */
function isAmbiguous(raw: string): boolean {
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || char === "\\" || char === "#") {
      return true;
    }
  }
  return false;
}

/**
 * The URL, or a refusal that does not repeat it: the input of a URL that
 * does not parse may still hold a password, and so may the part of it before
 * the host. Every refusal here names only what is wrong.
 */
function parseUrl(raw: string, what: Service): URL {
  const refuse = (why: string): Error =>
    new Error(`refusing to touch ${what}: its URL ${why} (${ENV_TEST})`);

  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(raw)?.[0].toLowerCase();
  const schemes: readonly string[] = SCHEMES[what];
  if (scheme === undefined || !schemes.includes(scheme)) {
    throw refuse(
      `is not a ${schemes.map((s) => `${s}//`).join(" or ")} URL${scheme === undefined ? "" : ` (scheme ${scheme})`}`,
    );
  }
  if (isAmbiguous(raw)) {
    throw refuse(
      "holds a space, a control character, a backslash or a fragment, which the driver reads differently from the URL standard",
    );
  }
  if (!raw.slice(scheme.length).startsWith("//")) {
    throw refuse("names no host");
  }
  // The authority as postgres-js cuts it: up to the first `/` or `?`.
  const authority = raw.slice(scheme.length + 2).split(/[/?]/)[0] ?? "";
  const userEnd = authority.indexOf("@");
  if (userEnd !== authority.lastIndexOf("@")) {
    throw refuse(
      "has a second `@` after the user, so the driver and the URL standard read another host from it",
    );
  }
  const driverHost = authority.slice(userEnd + 1);
  if (driverHost.includes(",")) {
    throw refuse("lists several hosts");
  }
  if (driverHost.includes("%")) {
    throw refuse("has a percent-encoded host, which the driver decodes");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("does not parse");
  }
  if (url.host !== driverHost) {
    throw refuse("names its host in a form the driver reads differently");
  }
  return url;
}

/** The host of a URL, without the brackets of an IPv6 literal. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** The path of a URL without its leading slash: a database name or number. */
function databaseOf(url: URL): string {
  return url.pathname.replace(/^\//, "");
}

function assertLocalService(
  url: URL,
  what: Service,
  expectedPort: string,
): void {
  const host = hostOf(url);
  const hosts: readonly string[] = TEST_STACK.hosts;
  if (!hosts.includes(host)) {
    throw new Error(
      `refusing to touch ${what} on host "${host}": integration tests only run against the local Compose test stack (${ENV_TEST})`,
    );
  }
  if (url.port !== expectedPort) {
    const port = url.port === "" ? "the default port" : `port ${url.port}`;
    throw new Error(
      `refusing to touch ${what} on ${port} of ${host}: the local Compose test stack listens on port ${expectedPort} (${ENV_TEST})`,
    );
  }
  if (url.search !== "") {
    // Names only: a value may be a password or a host.
    const names = Array.from(new Set(url.searchParams.keys())).join(", ");
    throw new Error(
      `refusing to touch ${what} on ${host}:${expectedPort} with connection options in its URL (${names}): the driver may read a host or a database from them (${ENV_TEST})`,
    );
  }
}

/**
 * Refuses anything but the local Postgres of the Compose test stack: host,
 * port and database. Called with the URL exactly as the environment gives it,
 * before any connection is opened.
 */
export function assertLocalTestPostgres(databaseUrl: string): void {
  const pg = parseUrl(databaseUrl, "Postgres");
  assertLocalService(pg, "Postgres", TEST_STACK.postgresPort);
  assertTestDatabaseName(databaseOf(pg));
}

/**
 * Refuses anything but the local Redis of the Compose test stack: host, port
 * and the database number `.env.test` names. Called with the URL exactly as
 * the environment gives it, before any connection is opened.
 */
export function assertLocalTestRedis(redisUrl: string): void {
  const redis = parseUrl(redisUrl, "Redis");
  assertLocalService(redis, "Redis", TEST_STACK.redisPort);
  const database = databaseOf(redis);
  if (database !== TEST_STACK.envRedisDatabase) {
    const named = database === "" ? "0 (none named)" : `"${database}"`;
    throw new Error(
      `refusing to touch queues in redis database ${named}: the integration tests are pointed at database ${TEST_STACK.envRedisDatabase} of the test stack (${ENV_TEST})`,
    );
  }
}

/**
 * Refuses a Postgres database other than the test one - for the name in a URL
 * and for the answer of `current_database()`, which is what the server is
 * really connected to.
 */
export function assertTestDatabaseName(name: string | undefined): void {
  if (name !== TEST_STACK.database) {
    throw new Error(
      `refusing to write to database "${name ?? ""}": integration tests only run against "${TEST_STACK.database}" (${ENV_TEST})`,
    );
  }
}

/**
 * The same Redis server as `redisUrl`, in the database `suite` owns. Checks
 * `redisUrl` with `assertLocalTestRedis` first - on what the environment says,
 * not on a database this function has just written into the URL: a guard
 * reading its own assignment cannot refuse anything. A suite that opens its
 * Redis through this function cannot skip the guard.
 */
export function suiteRedisUrl(redisUrl: string, suite: TestSuite): string {
  assertLocalTestRedis(redisUrl);
  const url = new URL(redisUrl);
  url.pathname = `/${TEST_REDIS_DATABASE_OF[suite]}`;
  return url.toString();
}
