import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { tableExists } from "./catalog.js";
import { type Db, closeDb, createDb } from "./client.js";
import { throwFailures } from "./failures.js";
import {
  type LockStatement,
  type MigrationLockOptions,
  releaseStepFailure,
  stepNamer,
  withMigrationLock,
} from "./migration-lock.js";

/** The options of `migrateDb`: the wait for the lock and the release steps. */
export type MigrateDbOptions = MigrationLockOptions;

/**
 * Every statement `migrateDb` runs through `execute`, by name: the ones of
 * the lock (`LockStatement`) and the count of the journal, the migrator's own.
 */
export type MigrateStatement = LockStatement | "count_journal";

const step = stepNamer<Exclude<MigrateStatement, LockStatement>>();

/**
 * Resolved from this module, not from `process.cwd()`: turbo runs tasks from
 * the package directory, the Compose one-shot service (E0-11) and CI run them
 * from elsewhere, and a folder missing at runtime would look like "no
 * migrations to apply" instead of an error. Exported for the test support of
 * this package (`assertMigrated` compares a database against it), not
 * through the barrel: nothing at runtime needs the path.
 */
export const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/** What one run of the migrator did, for the entry point to report. */
export interface MigrationOutcome {
  /** Migrations this run applied; 0 when the database was already current. */
  applied: number;
  /** Migrations recorded in the journal after the run. */
  total: number;
}

/**
 * Applies pending migrations on a connection the caller owns and closes,
 * inside `withMigrationLock` of `migration-lock.ts`, which holds the lock
 * and the session settings described here.
 *
 * drizzle reads the journal before it opens its transaction, so two runners
 * started together - the Compose service while a developer types
 * `pnpm db:migrate` - would both see an empty journal and the second would
 * fail on `CREATE TYPE ... already exists`. The advisory lock makes the second
 * wait until the first is done, and then it finds nothing to apply. The lock
 * belongs to the session, so it only serialises anything if the lock, the
 * migration and the unlock share one connection: a handle with a pool of more
 * than one is refused before it takes the lock. The wait is bounded by
 * `lockWaitMs`, after which the run fails with `MigrationLockTimeoutError`.
 * The wait is `lock_timeout` alone: `statement_timeout` is 0 while the runner
 * waits, so a session with a shorter one still waits `lockWaitMs` and gets
 * the same busy lock, and a `query_canceled` from the wait - an operator's
 * `pg_cancel_backend` - is thrown as it is, not named a busy lock.
 *
 * The session settings the run changes - `lock_timeout` and
 * `statement_timeout` for the wait, `client_min_messages` for the run - are
 * read first and put back to the values the caller's session had, not to the
 * server's defaults: a handle opened with `SET lock_timeout = '5s'` keeps its
 * 5 s after the run. Both timeouts are put back, in one statement, as soon as
 * the lock is held, so the migrations run under the session's own.
 *
 * Releasing - the steps `unlock`, `client_min_messages` and `timeouts` (both
 * timeouts in one statement), in that order - never throws: each step is
 * tried on its own and its failure goes to `onReleaseError` with the step's
 * name. The timeouts are put back there too, not only right after the lock
 * is taken: when that first restore fails, the session would otherwise keep
 * this run's wait. A failed attempt at the lock releases the lock in case the
 * server granted it as the attempt failed, puts both timeouts back and only
 * then throws (see `acquireMigrationLock` in `migration-lock.ts`).
 * When the migration failed, its own error is thrown; when it succeeded, its
 * outcome is returned - a failed unlock does not turn applied migrations into
 * an exit code 1, and the lock goes with the session when the caller closes it.
 */
export function migrateDb(
  db: Db,
  options: MigrateDbOptions = {},
): Promise<MigrationOutcome> {
  return withMigrationLock(db, options, async () => {
    const before = await countJournal(db);
    await migrate(db, { migrationsFolder });
    const total = await countJournal(db);
    return { applied: total - before, total };
  });
}

/** Rows of the drizzle journal; 0 before the first run created it. */
async function countJournal(db: Db): Promise<number> {
  if (!(await tableExists(db, "drizzle.__drizzle_migrations"))) {
    return 0;
  }
  const rows = await db.execute<{ n: number }>(
    step(
      "count_journal",
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    ),
  );
  return rows[0]?.n ?? 0;
}

/**
 * Applies pending migrations and closes its own connection. Takes the url as
 * a parameter so the library stays free of configuration, and opens it through
 * `createDb` so the runner reaches the database with the same connection
 * options as the applications; a single connection keeps the advisory lock and
 * the migration on one session (see `migrateDb`). Unlike `migrateDb` it does
 * not count the journal: nobody reads an outcome here.
 *
 * No failure is dropped. The failure of the run (the lock or a migration),
 * the failures of the steps that put the session back - each an `Error`
 * whose message is `releaseStepFailure(step, error)` and whose `cause` is
 * the driver's error - and the failure of closing the connection are
 * collected in that order: a single one is thrown as it is, several are
 * thrown together as an `AggregateError` whose message names each of them
 * with its code (`throwFailures`). Unlike `pnpm db:migrate`, a failed step
 * of putting the session back fails this run: its callers are test suites,
 * where a session left half restored is a defect to see rather than a
 * deploy to let through.
 */
export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  const failures: unknown[] = [];
  const released: Error[] = [];
  try {
    await withMigrationLock(
      db,
      {
        onReleaseError: (name, error) => {
          released.push(
            new Error(releaseStepFailure(name, error), { cause: error }),
          );
        },
      },
      () => migrate(db, { migrationsFolder }),
    );
  } catch (error) {
    failures.push(error);
  }
  failures.push(...released);
  try {
    await closeDb(db);
  } catch (error) {
    failures.push(error);
  }
  throwFailures(failures);
}
