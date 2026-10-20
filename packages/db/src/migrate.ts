import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode } from "@sf/core";
import { type SQL, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { tableExists } from "./catalog.js";
import { type Db, closeDb, createDb } from "./client.js";
import { describeError, throwFailures } from "./failures.js";

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

/**
 * Key of the session-level advisory lock every migration runner of a database
 * takes before it reads the journal. Shared by all runners on purpose - the
 * Compose `migrate` service, `pnpm db:migrate` and the test helpers all go
 * through `migrateDb` - so it must never change between releases: two runners
 * holding different keys would not wait for each other at all. The value only
 * has to be unique among the advisory locks of this database; it spells
 * "SFMG" in ASCII. Not exported through the barrel: a lock taken anywhere
 * but here would serialise nothing the migrator does. Exported from this
 * module for the integration tests of this package, which take the lock the
 * way a caller's session could have before a run.
 */
export const MIGRATION_LOCK_KEY = 0x53464d47;

/**
 * The row of `pg_locks` for the migration lock this session holds, if any. A
 * bigint key lies over two oid columns - its upper half in `classid`, its
 * lower half in `objid`, `objsubid` 1 - so the key is put back together from
 * both halves: `objid` alone would only match a key below 2^32.
 */
const HELD_MIGRATION_LOCK = sql`from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid() and objsubid = 1 and ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY}::bigint`;

/**
 * The one unlock of the run, after it and after a failed attempt alike: only
 * a lock the session holds is unlocked, so a lock that was never granted is
 * not unlocked with the server's WARNING, which the driver prints on stdout.
 */
const UNLOCK = sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint) ${HELD_MIGRATION_LOCK}`;

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

/**
 * Postgres `lock_not_available`: the `lock_timeout` of the wait ran out. The
 * only code that means a busy lock - the wait runs with `statement_timeout`
 * 0, so a `query_canceled` (57014) there is a real cancel, thrown as it is.
 */
const LOCK_NOT_AVAILABLE = "55P03";

/** One step of putting the session back after the run, by name. */
export type ReleaseStep = "unlock" | "client_min_messages" | "timeouts";

/** What failed, by step, in the line of a failed step. */
const RELEASE_STEP_FAILED: Record<ReleaseStep, string> = {
  unlock: "releasing the migration lock failed",
  client_min_messages: "restoring client_min_messages failed",
  timeouts: "restoring lock_timeout and statement_timeout failed",
};

/**
 * The line a failed step of putting the session back is reported with - on
 * stderr by `pnpm db:migrate`, as the message of the error `runMigrations`
 * throws: one text for both.
 */
export function releaseStepFailure(step: ReleaseStep, error: unknown): string {
  return `${RELEASE_STEP_FAILED[step]}: ${describeError(error)}`;
}

/**
 * Every statement `migrateDb` runs through `execute`, by name. The name is
 * the opening comment of the statement's text - `/* step:lock *\/ select
 * pg_advisory_lock(...)` - so a log of Postgres says which step a statement
 * was, and so does a test that makes one step fail. The restore of both
 * timeouts right after the lock is taken and the one when the run is over
 * share the rest of their text, not their name.
 */
export type MigrateStatement =
  | "read_session"
  | "lock_wait"
  | "lock"
  | "timeouts_after_lock"
  | "quiet_notices"
  | "count_journal"
  | ReleaseStep;

export interface MigrateDbOptions {
  /**
   * How long to wait for the lock, a whole number of milliseconds above 0;
   * `MIGRATION_LOCK_WAIT_MS` by default.
   */
  lockWaitMs?: number;
  /**
   * Receives a failure of a step that puts the session back - the unlock or
   * the restore of a setting - with the name of the step. Never thrown: the
   * migrations are applied (or the run's own failure is thrown), and the lock
   * ends with the session the caller closes anyway.
   */
  onReleaseError?: (step: ReleaseStep, error: unknown) => void;
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
 * Thrown when the lock stayed busy for the whole wait. The message says what
 * to do; the driver's error is the `cause`.
 */
export class MigrationLockTimeoutError extends Error {
  override name = "MigrationLockTimeoutError";
  /** How long this runner waited, in milliseconds. */
  readonly waitMs: number;

  constructor(waitMs: number, options: { cause: unknown }) {
    super(migrationLockTimeoutMessage(waitMs), { cause: options.cause });
    this.waitMs = waitMs;
  }
}

/** `query` with the name of its step as the opening comment of its text. */
function step(name: MigrateStatement, query: SQL): SQL {
  return sql`${sql.raw(`/* step:${name} */ `)}${query}`;
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
 * then throws (see `acquireMigrationLock`).
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

/**
 * Runs `body` under the migration lock, with the session prepared for it and
 * put back afterwards (see `migrateDb`).
 */
async function withMigrationLock<T>(
  db: Db,
  options: MigrateDbOptions,
  body: () => Promise<T>,
): Promise<T> {
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
  await acquireMigrationLock(db, lockWaitMs, session, onReleaseError);
  try {
    await db.execute(step("timeouts_after_lock", restoreTimeouts(session)));
    // drizzle creates its schema and journal with `IF NOT EXISTS` on every
    // run, and the driver prints each resulting NOTICE to stdout - two
    // objects of noise around the one line the entry point has to say.
    await db.execute(
      step("quiet_notices", sql`set client_min_messages = warning`),
    );
    return await body();
  } finally {
    await releaseQuietly(
      db,
      [
        ["unlock", UNLOCK],
        [
          "client_min_messages",
          setSession([["client_min_messages", session.clientMinMessages]]),
        ],
        ["timeouts", restoreTimeouts(session)],
      ],
      onReleaseError,
      "every_step",
    );
  }
}

/**
 * The settings of the caller's session `migrateDb` changes and puts back,
 * and whether the session held the migration lock before the run.
 */
interface SessionSettings {
  lockTimeout: string;
  statementTimeout: string;
  clientMinMessages: string;
  heldLock: boolean;
}

async function readSession(db: Db): Promise<SessionSettings> {
  const rows = await db.execute<{
    lock_timeout: string;
    statement_timeout: string;
    client_min_messages: string;
    held_lock: boolean;
  }>(
    step(
      "read_session",
      sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout, current_setting('client_min_messages') as client_min_messages, exists (select 1 ${HELD_MIGRATION_LOCK}) as held_lock`,
    ),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("migrateDb: the session settings could not be read");
  }
  return {
    lockTimeout: row.lock_timeout,
    statementTimeout: row.statement_timeout,
    clientMinMessages: row.client_min_messages,
    heldLock: row.held_lock,
  };
}

/** A setting of the session `migrateDb` changes and puts back. */
type SessionSetting =
  | "lock_timeout"
  | "statement_timeout"
  | "client_min_messages";

/**
 * Each name as the literal of the statement's text: the name is not a
 * parameter, so a log shows which setting a statement set.
 */
const SETTING_NAME: Record<SessionSetting, SQL> = {
  lock_timeout: sql.raw("'lock_timeout'"),
  statement_timeout: sql.raw("'statement_timeout'"),
  client_min_messages: sql.raw("'client_min_messages'"),
};

/**
 * Sets each of `settings` for the rest of the session, as `SET` does, in one
 * statement - one round trip however many there are.
 */
function setSession(
  settings: readonly (readonly [SessionSetting, string])[],
): SQL {
  const calls = settings.map(
    ([name, value]) => sql`set_config(${SETTING_NAME[name]}, ${value}, false)`,
  );
  return sql`select ${sql.join(calls, sql.raw(", "))}`;
}

/** Puts both timeouts of the caller's session back, in one statement. */
function restoreTimeouts(session: SessionSettings): SQL {
  return setSession([
    ["lock_timeout", session.lockTimeout],
    ["statement_timeout", session.statementTimeout],
  ]);
}

/**
 * Takes the lock, waiting at most `waitMs`. The wait is the session's
 * `lock_timeout`, with `statement_timeout` 0 - exactly 0, so that no
 * timeout of the caller's session ends the wait before `waitMs` does; the
 * caller puts both back once it holds the lock.
 *
 * A failed attempt cleans up here before it throws, in two steps. `unlock`
 * first - only a lock the session holds (`UNLOCK`): a cancel can land as the
 * server grants the lock, and the lock would then stay with a session the
 * caller may keep. A session that held the lock before the run skips it: its
 * lock is its own and must outlive the attempt. Then `timeouts`. The first
 * step that fails goes to `onReleaseError` by name and ends the cleanup: on
 * a dead connection every further statement would only wait out the connect
 * timeout and report a consequence, and the session that keeps this run's
 * wait is gone with the connection anyway.
 *
 * Only `55P03` of `pg_advisory_lock` itself becomes
 * `MigrationLockTimeoutError`: the `catch` holds that one statement, and any
 * other failure of it - a cancel (57014) included - is thrown as it is.
 */
async function acquireMigrationLock(
  db: Db,
  waitMs: number,
  session: SessionSettings,
  onReleaseError: (step: ReleaseStep, error: unknown) => void,
): Promise<void> {
  await db.execute(
    step(
      "lock_wait",
      setSession([
        ["lock_timeout", `${waitMs}ms`],
        ["statement_timeout", "0"],
      ]),
    ),
  );
  try {
    await db.execute(
      step("lock", sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`),
    );
  } catch (error) {
    const cleanup: (readonly [ReleaseStep, SQL])[] = session.heldLock
      ? []
      : [["unlock", UNLOCK]];
    cleanup.push(["timeouts", restoreTimeouts(session)]);
    await releaseQuietly(db, cleanup, onReleaseError, "until_failure");
    if (errorCode(error) === LOCK_NOT_AVAILABLE) {
      throw new MigrationLockTimeoutError(waitMs, { cause: error });
    }
    throw error;
  }
}

/**
 * Runs the release steps in order; a failure goes to `onReleaseError` by
 * name. `every_step` tries each step even if another failed;
 * `until_failure` stops at the first that failed.
 */
async function releaseQuietly(
  db: Db,
  steps: readonly (readonly [ReleaseStep, SQL])[],
  onReleaseError: (step: ReleaseStep, error: unknown) => void,
  mode: "every_step" | "until_failure",
): Promise<void> {
  for (const [name, statement] of steps) {
    try {
      await db.execute(step(name, statement));
    } catch (error) {
      onReleaseError(name, error);
      if (mode === "until_failure") return;
    }
  }
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
