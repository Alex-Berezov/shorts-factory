import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/**
 * A connection is opened by an explicit call, never by importing the package
 * (D3): a module-level `postgres(url)` made every importer - `tsc`, vitest,
 * drizzle-kit, the Next build - depend on a reachable database and on a parsed
 * `DATABASE_URL`. The url is a parameter, so the library side of `@sf/db`
 * stays on `db -> core` and only `src/cli/**` reads configuration
 * (docs/adr/0002-db-connection-and-cli-config.md).
 */
/**
 * How long a connection attempt is given, in seconds.
 *
 * postgres-js leaves this to the driver default otherwise, which means "as
 * long as the operating system takes to give up on the socket" - minutes on a
 * host that drops packets rather than refusing them. Every caller then
 * inherits a wait it did not choose: `pingDb` behind the health probe deadline
 * is the only one that has a bound of its own, while a migration or a worker
 * job would simply hang. Ten seconds is far above a healthy local or
 * in-network connect and far below "nobody will notice".
 */
const CONNECT_TIMEOUT_SEC = 10;

/**
 * The options every postgres-js client of the package is opened with: the
 * service handle of `createDb` and the raw client of the test fixture
 * (`openTestSql`) share them, while the raw client keeps the driver's own
 * parsers - drizzle installs pass-through ones on a client it wraps.
 */
export function clientOptions(opts?: {
  max?: number;
  connectTimeoutSec?: number;
}): { max: number; connect_timeout: number } {
  return {
    max: opts?.max ?? 10,
    connect_timeout: opts?.connectTimeoutSec ?? CONNECT_TIMEOUT_SEC,
  };
}

/**
 * The options `openDb` hands the driver: those of `clientOptions`, and the
 * session parameters a bounded handle of the package sets on its own client.
 */
export type OpenDbOptions = ReturnType<typeof clientOptions> & {
  connection?: { statement_timeout: number };
  /** `false` skips the `pg_type` query postgres-js sends on every connect. */
  fetch_types?: boolean;
};

/**
 * The one place a drizzle handle over a postgres-js client is made: the
 * service handle of `createDb` and the bounded handle of a probe
 * (`createProbeDb`, `probe.ts`) both open through it, so a change to how a
 * client is opened reaches both. Internal to the package - not in
 * `index.ts`: a session parameter passed through `createDb` would put the
 * limit of a probe on a migration or a worker job.
 */
export function openDb(url: string, options: OpenDbOptions) {
  return drizzle(postgres(url, options), { schema });
}

export function createDb(
  url: string,
  opts?: { max?: number; connectTimeoutSec?: number },
) {
  return openDb(url, clientOptions(opts));
}

/** Handle every repository and migration helper takes as its first argument. */
export type Db = ReturnType<typeof createDb>;

/**
 * Closes the underlying postgres-js client. The driver exposes it as
 * `$client`, so callers do not have to carry the client next to the `Db`.
 *
 * Without `timeoutSec` the driver waits for every query in flight, however
 * long that takes - what a worker draining its jobs and a migration holding
 * its lock need. With it, a query still in flight after `timeoutSec` is
 * destroyed: the bound a process stopping under a deadline of its own needs
 * against a Postgres that went silent (docs/TECH_DEBT.md § E0-12H, п.6).
 */
export async function closeDb(
  db: Db,
  opts?: { timeoutSec?: number },
): Promise<void> {
  // An undefined `timeout` is the driver's own default: wait for every query.
  await db.$client.end({ timeout: opts?.timeoutSec });
}
