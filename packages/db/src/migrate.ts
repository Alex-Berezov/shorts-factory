import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { tableExists } from "./catalog.js";
import { withCleanup } from "./cleanup.js";
import { type Db, closeDb, createDb } from "./client.js";

/**
 * Resolved from this module, not from `process.cwd()`: turbo runs tasks from
 * the package directory, the Compose one-shot service (E0-11) and CI run them
 * from elsewhere, and a folder missing at runtime would look like "no
 * migrations to apply" instead of an error.
 */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/**
 * Key of the session-level advisory lock every migration runner of a database
 * takes before it reads the journal. Shared by all runners on purpose - the
 * Compose `migrate` service, `pnpm db:migrate` and the test helpers all go
 * through `migrateDb` - so it must never change between releases: two runners
 * holding different keys would not wait for each other at all. The value only
 * has to be unique among the advisory locks of this database; it spells
 * "SFMG" in ASCII. Not exported: a lock taken anywhere but here would
 * serialise nothing the migrator does.
 */
const MIGRATION_LOCK_KEY = 0x53464d47;

/** What one run of the migrator did, for the entry point to report. */
export interface MigrationOutcome {
  /** Migrations this run applied; 0 when the database was already current. */
  applied: number;
  /** Migrations recorded in the journal after the run. */
  total: number;
}

/** Thrown before anything runs when the handle could not hold the lock. */
export const MIGRATE_NEEDS_SINGLE_CONNECTION =
  "migrateDb needs a handle opened with createDb(url, { max: 1 }): the advisory lock belongs to one session";

/**
 * How long a runner waits for another one to finish. Migrations of this
 * project take seconds; a runner still holding the lock after this long is
 * stuck, and waiting on it silently would keep the Compose `migrate` service -
 * and every service started after it - from ever starting.
 */
export const MIGRATION_LOCK_WAIT_MS = 120_000;

/** Postgres `lock_not_available`: `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = "55P03";

export interface MigrateDbOptions {
  /**
   * How long to wait for the lock, a whole number of milliseconds above 0;
   * `MIGRATION_LOCK_WAIT_MS` by default.
   */
  lockWaitMs?: number;
  /**
   * Receives a failure of releasing the lock or restoring the session after
   * the run. Never thrown: the migrations are applied (or their own failure is
   * thrown), and the lock ends with the session the caller closes anyway.
   */
  onReleaseError?: (error: unknown) => void;
}

/**
 * The message a runner gives up with when another one holds the lock. `waitMs`
 * is this runner's wait, not how long the other one has held the lock - that
 * may be far longer, so the text says "at least".
 */
export function migrationLockTimeoutMessage(waitMs: number): string {
  return `another migration runner has held the migration lock for at least the ${waitMs} ms this one waited - find it in pg_stat_activity (wait_event_type 'Lock' or a long 'active' query) and stop it, then run the migrations again`;
}

/**
 * Applies pending migrations on a connection the caller owns and closes.
 *
 * drizzle reads the journal before it opens its transaction, so two runners
 * started together - the Compose service while a developer types
 * `pnpm db:migrate` - would both see an empty journal and the second would
 * fail on `CREATE TYPE ... already exists`. The advisory lock makes the second
 * wait until the first is done, and then it finds nothing to apply. The lock
 * belongs to the session, so it only serialises anything if the lock, the
 * migration and the unlock share one connection: a handle with a pool of more
 * than one is refused before it takes the lock. The wait is bounded by
 * `lockWaitMs`, after which the run fails with a message saying so.
 *
 * The session settings the run changes - `lock_timeout` for the wait,
 * `client_min_messages` for the run - are read first and put back to the
 * values the caller's session had, not to the server's defaults: a handle
 * opened with `SET lock_timeout = '5s'` keeps its 5 s after the run.
 *
 * Releasing - the unlock first, then `client_min_messages` and
 * `lock_timeout` - never throws: each step is tried on its own and its failure
 * goes to `onReleaseError`. `lock_timeout` is put back there too, not only
 * right after the lock is taken: when that first restore fails, the session
 * would otherwise keep this run's wait.
 * When the migration failed, its own error is thrown; when it succeeded, its
 * outcome is returned - a failed unlock does not turn applied migrations into
 * an exit code 1, and the lock goes with the session when the caller closes it.
 */
export async function migrateDb(
  db: Db,
  options: MigrateDbOptions = {},
): Promise<MigrationOutcome> {
  if (db.$client.options.max !== 1) {
    throw new Error(MIGRATE_NEEDS_SINGLE_CONNECTION);
  }
  const lockWaitMs = options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS;
  // `lock_timeout` 0 means "wait forever" - the very hang the wait exists to
  // prevent - and a fraction or NaN would reach Postgres as a raw error.
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs <= 0) {
    throw new Error(
      `migrateDb: lockWaitMs must be a whole number of milliseconds above 0, got ${lockWaitMs}`,
    );
  }
  const onReleaseError = options.onReleaseError ?? (() => undefined);

  const session = await readSession(db);
  await acquireMigrationLock(db, lockWaitMs, session.lockTimeout);
  try {
    await db.execute(setSession("lock_timeout", session.lockTimeout));
    // drizzle creates its schema and journal with `IF NOT EXISTS` on every
    // run, and the driver prints each resulting NOTICE to stdout - two
    // objects of noise around the one line the entry point has to say.
    await db.execute(sql`set client_min_messages = warning`);
    const before = await countJournal(db);
    await migrate(db, { migrationsFolder });
    const total = await countJournal(db);
    return { applied: total - before, total };
  } finally {
    await releaseQuietly(db, session, onReleaseError);
  }
}

/** The settings of the caller's session `migrateDb` changes and puts back. */
interface SessionSettings {
  lockTimeout: string;
  clientMinMessages: string;
}

async function readSession(db: Db): Promise<SessionSettings> {
  const rows = await db.execute<{
    lock_timeout: string;
    client_min_messages: string;
  }>(
    sql`select current_setting('lock_timeout') as lock_timeout, current_setting('client_min_messages') as client_min_messages`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("migrateDb: the session settings could not be read");
  }
  return {
    lockTimeout: row.lock_timeout,
    clientMinMessages: row.client_min_messages,
  };
}

/**
 * Sets `name` for the rest of the session, as `SET` does. The name is part of
 * the statement's text, not a parameter, so a log shows which one it was.
 */
function setSession(
  name: "lock_timeout" | "client_min_messages",
  value: string,
): SQL {
  return name === "lock_timeout"
    ? sql`select set_config('lock_timeout', ${value}, false)`
    : sql`select set_config('client_min_messages', ${value}, false)`;
}

/**
 * Takes the lock, waiting at most `waitMs`. The session's `lock_timeout` is
 * the wait; the caller puts `ownTimeout` back once it holds the lock, and a
 * failed attempt puts it back here, without letting that hide why the attempt
 * failed.
 */
async function acquireMigrationLock(
  db: Db,
  waitMs: number,
  ownTimeout: string,
): Promise<void> {
  await db.execute(setSession("lock_timeout", `${waitMs}ms`));
  try {
    await db.execute(
      sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`,
    );
  } catch (error) {
    try {
      await db.execute(setSession("lock_timeout", ownTimeout));
    } catch {
      // The attempt's own failure below is the one to report.
    }
    if (isLockTimeout(error)) {
      throw new Error(migrationLockTimeoutMessage(waitMs), { cause: error });
    }
    throw error;
  }
}

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === LOCK_NOT_AVAILABLE
  );
}

/** The unlock, then the session settings - each tried even if another fails. */
async function releaseQuietly(
  db: Db,
  session: SessionSettings,
  onReleaseError: (error: unknown) => void,
): Promise<void> {
  const steps = [
    sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`,
    setSession("client_min_messages", session.clientMinMessages),
    setSession("lock_timeout", session.lockTimeout),
  ];
  for (const step of steps) {
    try {
      await db.execute(step);
    } catch (error) {
      onReleaseError(error);
    }
  }
}

/** Rows of the drizzle journal; 0 before the first run created it. */
async function countJournal(db: Db): Promise<number> {
  if (!(await tableExists(db, "drizzle.__drizzle_migrations"))) {
    return 0;
  }
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Applies pending migrations and closes its own connection. Takes the url as
 * a parameter so the library stays free of configuration, and opens it through
 * `createDb` so the runner reaches the database with the same connection
 * options as the applications; a single connection keeps the advisory lock and
 * the migration on one session (see `migrateDb`).
 *
 * When the migration fails, the failure of closing the connection afterwards
 * is dropped rather than thrown (`withCleanup`). Callers that want to report
 * it open the connection themselves and call `migrateDb` (as
 * `src/cli/migrate.ts` does).
 */
export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  await withCleanup(
    () => migrateDb(db),
    () => closeDb(db),
    () => undefined,
  );
}
