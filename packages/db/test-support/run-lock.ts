import { env } from "@sf/config";
import { type SQL, sql } from "drizzle-orm";
import type { ProbeDb } from "../src/probe.js";
import {
  afterFailure,
  closeSessionCheckClient,
  openSessionCheckClient,
  sessionCheckRefusal,
} from "./other-sessions.js";
import { TEST_STACK } from "./stack-guard.js";

/**
 * Key of the session-level advisory lock an integration run holds on the
 * test database from its entry check to its teardown. Its own key, not the
 * one of the migration runner (`MIGRATION_LOCK_KEY` in `../src/migration-lock.ts`):
 * a run migrates under that one, and would wait for itself. It spells "SFRN"
 * in ASCII; it only has to be unique among the advisory locks of the test
 * database, and it lives in the test support only - nothing the product runs
 * takes it.
 */
export const RUN_LOCK_KEY = 0x5346524e;

/** The lock a run holds; `release` ends it and closes its client. */
export interface RunLock {
  release(): Promise<void>;
}

/**
 * The holder of a lock as the refusal names it: a row of `pg_locks` joined
 * with `pg_stat_activity` on the test database.
 */
interface LockHolder {
  readonly pid: number;
  readonly applicationName: string;
  readonly backendStart: string | null;
}

const lockQueries = (key: number) => ({
  take: sql`SELECT pg_try_advisory_lock(${key}::bigint) AS taken`,
  release: sql`SELECT pg_advisory_unlock(${key}::bigint) AS released`,
  // A bigint key lies over two oid columns - its upper half in `classid`,
  // its lower half in `objid`, `objsubid` 1 (as `HELD_MIGRATION_LOCK` of
  // `../src/migration-lock.ts` reads it).
  holders: sql`
    SELECT l.pid,
           a.application_name AS "applicationName",
           a.backend_start::text AS "backendStart"
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
       AND ((l.classid::bigint << 32) | l.objid::bigint) = ${key}::bigint
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `,
});

/**
 * The barrier of an integration run against a second one on the same test
 * database (docs/TECH_DEBT.md, E0-12O): every run resets the database or
 * works on what `@sf/db` migrated, so two at once break each other. Both
 * entry checks of `./entry-check/` take it first, before any other read, and
 * hold it until the teardown of their `globalSetup`; the files of the run
 * never touch it. A run that finds it taken is refused, naming the holder by
 * `pid`, `application_name` and `backend_start` and how to end it - the
 * lock lives on the holder's session, so a run killed outright lets it go
 * with its connection, and only a process that hangs keeps it.
 *
 * `pg_try_advisory_lock`, not `pg_advisory_lock`: a second run is refused at
 * once, it does not queue behind the first. The session counting of
 * `./other-sessions.ts` stays behind it for clients that take no lock.
 *
 * The client is the one of the checks (`openSessionCheckClient`): one
 * connection, bounded, named `SESSION_CHECK_APPLICATION`, so the session
 * check of the same run does not count it. A read that fails is refused as
 * a database that cannot be reached or does not answer
 * (`sessionCheckRefusal`); on a refusal the client is closed before the
 * throw, and a close that fails too is the second line of that refusal, not
 * the refusal (`afterFailure`). The client opens its one connection with no
 * lifetime: `keepConnection` of `SESSION_CHECK_BOUNDS` (`./other-sessions.ts`),
 * which `createProbeDb` turns into `max_lifetime: null` - a connection the
 * driver replaced by age would take the lock with it in the middle of a run.
 * An unlock that finds no lock of its session (`released` not true) is thrown
 * at the teardown: the run lost its barrier on the way; a close that fails
 * after a clean unlock is a refusal of its own (`closeSessionCheckClient`).
 *
 * What it does not cover: the moment between two packages of one run
 * (`turbo run test:int --concurrency=1`) - the lock of `@sf/db` is released
 * at its teardown and the api takes its own; a second run that starts then
 * takes the lock and the first one is refused in its next package. And
 * Redis: a run that only touches Redis takes no lock (docs/60_HARNESS.md,
 * «Известные ограничения»).
 *
 * `key` is for the tests of the lock itself, which cannot take the key of
 * the run they are part of.
 */
export async function takeRunLock(
  key: number = RUN_LOCK_KEY,
): Promise<RunLock> {
  const probe = openSessionCheckClient();
  const queries = lockQueries(key);
  try {
    const [row] = await read(probe, queries.take);
    if (field(row, "taken") === true) {
      return { release: () => releaseRunLock(probe, queries.release) };
    }
    if (field(row, "taken") !== false) {
      throw new Error(
        `pg_try_advisory_lock gave a row the run lock cannot read: ${JSON.stringify(row)}`,
      );
    }
    throw new Error(
      runLockRefusal(holdersOf(await read(probe, queries.holders))),
    );
  } catch (error) {
    return afterFailure(error, "closing its client", () =>
      probe.close({ timeoutSec: 0 }),
    );
  }
}

/**
 * Takes the run lock, then runs `checks` under it; a check that fails lets
 * the lock go before its refusal goes on - vitest calls no teardown for a
 * `globalSetup` whose setup threw.
 */
export async function lockRun(checks: () => Promise<void>): Promise<RunLock> {
  const lock = await takeRunLock();
  try {
    await checks();
  } catch (error) {
    return afterFailure(error, "letting the run lock go", () => lock.release());
  }
  return lock;
}

async function releaseRunLock(probe: ProbeDb, release: SQL): Promise<void> {
  let row: unknown;
  try {
    // Ended by the close of the session anyway; unlocked first so the next
    // package of the run finds it free the moment this one is done.
    [row] = await read(probe, release);
  } catch (error) {
    return afterFailure(error, "closing its client", () =>
      probe.close({ timeoutSec: 0 }),
    );
  }
  if (field(row, "released") !== true) {
    // Not the lock of this session any more: its connection went under the
    // run, and whatever ran after that ran without the barrier.
    return afterFailure(
      new Error(
        `pg_advisory_unlock found no run lock on the session that took it (${JSON.stringify(row)}): its connection was replaced or ended during the run, and a second run could have reset the test database ${TEST_STACK.database} under it - the run is not to be trusted`,
      ),
      "closing its client",
      () => probe.close({ timeoutSec: 0 }),
    );
  }
  await closeSessionCheckClient(probe, "letting the run lock go");
}

async function read(probe: ProbeDb, query: SQL): Promise<readonly unknown[]> {
  try {
    return await probe.run((db) => db.execute(query));
  } catch (error) {
    throw sessionCheckRefusal("the run lock", error);
  }
}

/** The holders of the lock, each narrowed; a row of another shape is thrown with its text. */
function holdersOf(rows: readonly unknown[]): LockHolder[] {
  return rows.map((row) => {
    const pid = field(row, "pid");
    const applicationName = field(row, "applicationName");
    const backendStart = field(row, "backendStart");
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      typeof applicationName !== "string" ||
      !(backendStart === null || typeof backendStart === "string")
    ) {
      throw new Error(
        `pg_locks gave a row the run lock cannot read: ${JSON.stringify(row)}`,
      );
    }
    return { pid, applicationName, backendStart };
  });
}

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null
    ? Reflect.get(row, name)
    : undefined;
}

/** The text of the refusal of a lock that is taken, by its holders. */
function runLockRefusal(holders: readonly LockHolder[]): string {
  const head = `another integration run holds the run lock of the test database ${TEST_STACK.database}`;
  const tail =
    "; a second run would reset the database under the first. Wait for it to finish, then run again";
  if (holders.length === 0) {
    // Taken at the try, gone by the read of the holder: it has just ended.
    return `${head} - its holder left before it could be named${tail}.`;
  }
  const listed = holders
    .map(
      ({ pid, applicationName, backendStart }) =>
        `pid=${pid} application_name=${JSON.stringify(applicationName)} backend_start=${backendStart ?? "unknown"}`,
    )
    .join("; ");
  const pids = holders.map(({ pid }) => pid).join(", ");
  // The lock lives on the session of the run, not in its process: ending
  // the session of a run that is alive drops its barrier while it goes on,
  // and leaves the other clients of a run that hangs where they are.
  // The user is the one of the URL the guard passed; the password is not named.
  const user = new URL(env.DATABASE_URL).username;
  return `${head}: ${listed}${tail}. A run that hangs is ended by its own process first (Ctrl+C in its terminal, or the vitest/turbo process it runs in); its sessions go with it. Only a session whose process is already gone is ended by its pid - on a run that is still alive this drops its barrier and lets the next run reset the database under it: docker compose -f infra/docker-compose.yml exec postgres psql -U ${user} -d ${TEST_STACK.database} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (${pids})"`;
}
