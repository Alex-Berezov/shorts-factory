import { sql as drizzleSql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type Db, closeDb, createDb } from "../src/client.js";
import {
  MIGRATE_NEEDS_SINGLE_CONNECTION,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_WAIT_MS,
  MigrationLockTimeoutError,
  migrateDb,
  migrationLockTimeoutMessage,
  migrationsFolder,
  runMigrations,
} from "../src/migrate.js";
import {
  heldAdvisoryLocks,
  waitForAdvisoryWaiter,
} from "../test-support/advisory-locks.js";
import {
  emptyTestDatabase,
  openMaintenanceSql,
  openTestSql,
  resetTestDatabase,
  testDatabaseUrl,
} from "../test-support/fixture.js";
import {
  countedTestSessions,
  sessionKey,
} from "../test-support/other-sessions.js";
import { openRelay } from "../test-support/relay.js";
import { RUN_LOCK_KEY } from "../test-support/run-lock.js";
import { captureProcessOutput } from "./capture-output.js";
import { failStep, stepOf } from "./migrate-steps.js";

/** Migrations the repository ships, read the way drizzle's migrator reads them. */
const SHIPPED_MIGRATIONS = readMigrationFiles({ migrationsFolder }).length;

/**
 * DoD of E0-04: the migration runner brings an empty database to the model of
 * System Design §5. The table list is a literal - a list read from the schema
 * would pass even if the migration created nothing.
 */
const TABLES_SECTION_5 = [
  "analytics_daily",
  "api_usage_log",
  "app_setting",
  "dub_track",
  "experiment",
  "experiment_recommendation",
  "idea",
  "idea_source_video",
  "oauth_token",
  "own_video",
  "production_package",
  "prompt_version",
  "research_brief",
  "script",
  "story_cluster",
  "story_cluster_video",
  "tracked_channel",
  "tracked_video",
  "trend_signal",
  "video_analysis",
  "video_stats_snapshot",
];

/** The address of the test database, through the guard - every handle of the file opens it. */
const TEST_DATABASE_URL = testDatabaseUrl().href;

const sql = openTestSql();

/** The drizzle handle of the file, apart from `sql`: drizzle sets the parsers of the client it wraps. */
const sessionsDb = createDb(TEST_DATABASE_URL, { max: 1 });

/**
 * Waits until no session of the test database holds an advisory lock. A
 * session closed while it still held one - the unlock failed, the process
 * left - is ended by the server asynchronously, so a read right after
 * `closeDb` can still see that lock. A run that released its lock itself
 * (`migrateDb` unlocks before `runMigrations` closes the handle, as in the
 * `beforeEach(migrate)` hooks of this file) leaves none behind to wait for:
 * the cases that read `heldAdvisoryLocks(sql)` straight after it read the
 * state as it is.
 */
async function expectNoAdvisoryLocks(): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    },
    { timeout: 5_000, interval: 50 },
  );
}

/**
 * The client sessions of the test database right now, as the entry check of
 * the run counts them (`countedTestSessions`): no autovacuum or other process
 * of the server, no healthcheck. Each is its `sessionKey` - a pid the server
 * gave again to a session the command left open is not the session of before.
 * Both handles of the file are opened first: a session this file opens after
 * the snapshot would count as one the command left.
 */
async function testDatabaseSessions(): Promise<string[]> {
  await sql`SELECT 1`;
  const sessions = await countedTestSessions(sessionsDb);
  return sessions.map(sessionKey);
}

/**
 * An entry point run in this process leaves the test database as it found
 * it: no advisory lock, and no session of its own - closed by the command,
 * not by the process exiting, which here it does not. `before` is
 * `testDatabaseSessions()` read before the command; the session of the run
 * lock or a backend still ending from a hook is in it and does not count.
 *
 * The locks are read first, while a session the command forgot is still
 * open: a closed session holds no lock whatever the run did, so read after
 * the session is gone the lock could not fail. An entry point that kept its
 * lock and its session fails the first read; one that released the lock but
 * never closed its handle fails the second. Both wait: the server ends a
 * closed session, and the lock with it, asynchronously.
 */
async function expectEntryPointLeftNothing(before: string[]): Promise<void> {
  await expectNoAdvisoryLocks();
  await vi.waitFor(
    async () => {
      const left = (await testDatabaseSessions()).filter(
        (key) => !before.includes(key),
      );
      expect(left, "sessions the entry point left open").toEqual([]);
    },
    { timeout: 5_000, interval: 50 },
  );
}

/** The tables of schema `public`, by name. */
async function publicTables(): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

/** The session settings `migrateDb` changes, as the session has them now. */
async function sessionSettings(db: Db): Promise<
  | {
      lock_timeout: string;
      statement_timeout: string;
      client_min_messages: string;
    }
  | undefined
> {
  const rows = await db.execute<{
    lock_timeout: string;
    statement_timeout: string;
    client_min_messages: string;
  }>(
    drizzleSql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout, current_setting('client_min_messages') as client_min_messages`,
  );
  return rows[0];
}

/** Advisory locks the session of `db` holds right now. */
async function locksHeldBy(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    drizzleSql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()`,
  );
  return rows[0]?.n ?? -1;
}

/**
 * A first runner stuck inside its migration while it holds the lock: a
 * second session holds the journal table until `release`. `stuck` is the
 * first runner's run; `dispose` releases and closes everything.
 */
async function holdMigrationLock(): Promise<{
  stuck: Promise<unknown>;
  release: () => void;
  dispose: () => Promise<void>;
}> {
  const first = createDb(TEST_DATABASE_URL, { max: 1 });
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const holderSql = openTestSql();
  const holder = holderSql.begin(async (tx) => {
    await tx`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`;
    await held;
  });
  const stuck = migrateDb(first);
  stuck.catch(() => undefined);
  await waitForLockWaiter();
  return {
    stuck,
    release,
    dispose: async () => {
      release();
      await holder;
      await holderSql.end();
      await closeDb(first);
    },
  };
}

/** One statement of `migrateDb` and the session's timeouts right after it. */
interface ObservedStatement {
  name: string | undefined;
  /** `pg_settings.setting`: milliseconds, "0" for "wait forever". */
  lockTimeoutMs: string;
  /** `pg_settings.setting`: milliseconds, "0" for "no limit". */
  statementTimeoutMs: string;
}

/**
 * Records, after every statement `db` runs through `execute`, the
 * `lock_timeout` and `statement_timeout` of its session. The handle has one
 * connection, so the probe reads the very session the statement ran on.
 */
function observeLockTimeout(db: Db): ObservedStatement[] {
  const observed: ObservedStatement[] = [];
  const execute = db.execute.bind(db);
  const probe = drizzleSql`select (select setting from pg_settings where name = 'lock_timeout') as lock_timeout, (select setting from pg_settings where name = 'statement_timeout') as statement_timeout`;
  vi.spyOn(db, "execute").mockImplementation(
    (query) =>
      (async () => {
        const result = await execute(query);
        const rows = await execute(probe);
        const lockTimeout = rows[0]?.lock_timeout;
        const statementTimeout = rows[0]?.statement_timeout;
        observed.push({
          name: stepOf(query),
          lockTimeoutMs: typeof lockTimeout === "string" ? lockTimeout : "",
          statementTimeoutMs:
            typeof statementTimeout === "string" ? statementTimeout : "",
        });
        return result;
      })() as ReturnType<typeof execute>,
  );
  return observed;
}

/** The observed statements that run while `migrateDb` holds the lock. */
function underTheLock(observed: ObservedStatement[]): ObservedStatement[] {
  const locked = observed.findIndex((s) => s.name === "lock");
  const unlocked = observed.findIndex((s) => s.name === "unlock");
  if (locked < 0 || unlocked < locked) {
    throw new Error("migrateDb did not take and release its lock");
  }
  return observed.slice(locked + 1, unlocked);
}

// The file starts from a reset database - a stray type a previous run left
// under a full journal is gone. A case that needs a migrated database gets
// one from the `beforeEach(migrate)` of its `describe`: `runMigrations`
// applies nothing to one, and the whole folder to one a previous case
// emptied. A case about an empty or a broken database lives in a `describe`
// "... from an empty database" without that hook - migrating first only to
// empty it again was a run and a lock for nothing - makes the database so
// itself, and resets it in its `finally`. The helpers of the test support at
// the end read `pg_locks` only and need neither.
beforeAll(async () => {
  await resetTestDatabase();
});

/** The hook of every `describe` whose cases start from a migrated database. */
async function migrate(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}

afterAll(async () => {
  await closeDb(sessionsDb);
  await sql.end();
});

describe("runMigrations", () => {
  beforeEach(migrate);

  it("is idempotent: a second run applies nothing and does not fail", async () => {
    const before = await publicTables();

    await expect(runMigrations(TEST_DATABASE_URL)).resolves.toBeUndefined();

    // The same tables by name, not only as many: a second pass that dropped
    // one table and created another would keep the count.
    expect(await publicTables()).toEqual(before);
    expect(before).toEqual(TABLES_SECTION_5);
  });
});

describe("runMigrations from an empty database", () => {
  it("creates every table of System Design §5 on an empty database", async () => {
    await emptyTestDatabase();
    await runMigrations(TEST_DATABASE_URL);

    expect(await publicTables()).toEqual(TABLES_SECTION_5);
  });

  /**
   * The only failure of the run is thrown as it is - with its SQLSTATE - not
   * wrapped together with nothing.
   */
  it("throws a failed migration as it is", async () => {
    await emptyTestDatabase();
    // The first statement of 0000_core, already there: the migration fails.
    await sql`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
    try {
      const run = runMigrations(TEST_DATABASE_URL);
      await expect(run).rejects.toMatchObject({ code: "42710" });
      await expect(run).rejects.not.toBeInstanceOf(AggregateError);
    } finally {
      await resetTestDatabase();
    }
  });
});

describe("migrateDb", () => {
  beforeEach(migrate);

  it("waits for the lock at most MIGRATION_LOCK_WAIT_MS by default", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const observed = observeLockTimeout(db);
    try {
      await migrateDb(db);
    } finally {
      await closeDb(db);
    }

    // Exactly 0 while it waits: no timeout of the session ends the wait
    // before `lock_timeout` does.
    const lock = observed.find((s) => s.name === "lock");
    expect(lock).toMatchObject({
      lockTimeoutMs: String(MIGRATION_LOCK_WAIT_MS),
      statementTimeoutMs: "0",
    });
  });

  /**
   * The wait is for the advisory lock only: left in place, it would also cut
   * short every statement of the migration that waits for a table lock - and
   * the `statement_timeout` 0 of the wait would lift the session's own limit
   * from every statement of the migration.
   */
  it("runs the migration under the session's own lock_timeout and statement_timeout", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const observed = observeLockTimeout(db);
    let before = "";
    try {
      await db.$client`set statement_timeout = '30s'`;
      const rows = await db.$client<{ setting: string }[]>`
        select setting from pg_settings where name = 'lock_timeout'`;
      before = rows[0]?.setting ?? "";
      await migrateDb(db);
    } finally {
      await closeDb(db);
    }

    const statements = underTheLock(observed);
    expect(statements.length).toBeGreaterThan(0);
    expect(new Set(statements.map((s) => s.lockTimeoutMs))).toEqual(
      new Set([before]),
    );
    // From the restore right after the lock on, the session's 30 s.
    const restored = statements.findIndex(
      (s) => s.name === "timeouts_after_lock",
    );
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(
      new Set(statements.slice(restored).map((s) => s.statementTimeoutMs)),
    ).toEqual(new Set(["30000"]));
  });

  it("reports nothing to apply on a current database", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await expect(migrateDb(db)).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
    } finally {
      await closeDb(db);
    }
  });
});

describe("migrateDb from an empty database", () => {
  /**
   * The Compose `migrate` service and a developer's `pnpm db:migrate` can
   * start together. drizzle reads its journal before its transaction, so
   * without the advisory lock both runners see an empty journal and the second
   * fails on `CREATE TYPE ... already exists`.
   */
  it("serialises two runners started together on an empty database", async () => {
    await emptyTestDatabase();
    const first = createDb(TEST_DATABASE_URL, { max: 1 });
    const second = createDb(TEST_DATABASE_URL, { max: 1 });

    try {
      const outcomes = await Promise.allSettled([
        migrateDb(first),
        migrateDb(second),
      ]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const applied = outcomes.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value.applied : -1,
      );
      expect(applied.sort((a, b) => a - b)).toEqual([0, SHIPPED_MIGRATIONS]);
    } finally {
      await closeDb(first);
      await closeDb(second);
    }

    const journal = await sql<{ hash: string; runs: number }[]>`
      SELECT hash, count(*)::int AS runs FROM drizzle.__drizzle_migrations
      GROUP BY hash
    `;
    expect(journal).toHaveLength(SHIPPED_MIGRATIONS);
    expect(journal.every((row) => row.runs === 1)).toBe(true);
  });
});

describe("migrateDb on failure", () => {
  beforeEach(migrate);

  /**
   * `lock_timeout` 0 is "wait forever" - the hang the wait exists to prevent;
   * a fraction or NaN would reach Postgres as a raw error.
   */
  it.each([0, Number.NaN, -1, 1.5])(
    "refuses lockWaitMs %s before its first query",
    async (lockWaitMs) => {
      const db = createDb(TEST_DATABASE_URL, { max: 1 });
      const execute = vi.spyOn(db, "execute");
      try {
        await expect(migrateDb(db, { lockWaitMs })).rejects.toThrow(
          `migrateDb: lockWaitMs must be a whole number of milliseconds above 0, got ${lockWaitMs}`,
        );
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await closeDb(db);
      }
    },
  );

  /**
   * Read while the pool is still open: closing it ends its sessions, and any
   * lock one of them took would be gone before a read after `closeDb`.
   */
  it("refuses a pooled handle before it takes the lock", async () => {
    await expectNoAdvisoryLocks();
    const pooled = createDb(TEST_DATABASE_URL);
    // Nothing reaches the database first: a lock taken and released before
    // the refusal would leave no trace in `pg_locks`.
    const execute = vi.spyOn(pooled, "execute");
    try {
      await expect(migrateDb(pooled)).rejects.toThrow(
        MIGRATE_NEEDS_SINGLE_CONNECTION,
      );
      expect(execute).toHaveBeenCalledTimes(0);
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      await closeDb(pooled);
    }
  });

  it("restores client_min_messages of the handle it was given", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await migrateDb(db);
      const rows = await db.execute<{ client_min_messages: string }>(
        drizzleSql`show client_min_messages`,
      );
      expect(rows[0]?.client_min_messages).toBe("notice");
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The session's own values, not the server's defaults: a caller that set
   * them before the run gets them back.
   */
  it("puts back the lock_timeout and client_min_messages the session had", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set statement_timeout = '45s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      await migrateDb(db);
      expect(await sessionSettings(db)).toEqual({
        lock_timeout: "5s",
        statement_timeout: "45s",
        client_min_messages: "error",
      });
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The very first step of taking the lock - setting the wait - fails: the
   * run fails with it before it holds the lock or changed the session, and
   * there is nothing to put back.
   */
  it("fails before it holds the lock when setting the wait fails", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const waitError = new Error("set_config failed");
    const onReleaseError = vi.fn();
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set statement_timeout = '45s'`);
      const fault = failStep(db, "lock_wait", waitError);
      await expect(
        migrateDb(db, { lockWaitMs: 300, onReleaseError }),
      ).rejects.toBe(waitError);
      expect(fault.hits).toBe(1);
      // Read while the session is open: a lock it took would still be held.
      expect(await heldAdvisoryLocks(sql)).toBe(0);
      expect(onReleaseError).toHaveBeenCalledTimes(0);
      expect(await sessionSettings(db)).toEqual({
        lock_timeout: "5s",
        statement_timeout: "45s",
        client_min_messages: "notice",
      });
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The run fails on its first statement under the lock - putting the
   * session's own timeouts back after the wait (`timeouts_after_lock`; the
   * release step `timeouts` shares its text, not its name). The release must
   * restore them again: otherwise the caller's handle silently keeps the
   * run's wait.
   */
  it("puts both timeouts back when restoring them after the lock fails", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const restoreError = new Error("restore failed");
    const onReleaseError = vi.fn();
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set statement_timeout = '45s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      const fault = failStep(db, "timeouts_after_lock", restoreError);
      await expect(
        migrateDb(db, { lockWaitMs: 300, onReleaseError }),
      ).rejects.toBe(restoreError);
      expect(fault.hits).toBe(1);
      expect(onReleaseError).toHaveBeenCalledTimes(0);
      expect(await sessionSettings(db)).toEqual({
        lock_timeout: "5s",
        statement_timeout: "45s",
        client_min_messages: "error",
      });
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The database goes away mid-migration (the relay in front of it is cut):
   * the migration's query fails, and so does the cleanup after it - the
   * reconnect is refused. The operator must
   * see why the migration stopped, not that the unlock could not connect.
   */
  it("throws the migration failure, not the failure of releasing the lock", async () => {
    const relay = await openRelay();
    const db = createDb(relay.url, { max: 1, connectTimeoutSec: 2 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    // A second connection: the transaction holds it until the end.
    const holderSql = openTestSql();
    const holder = holderSql.begin(async (tx) => {
      await tx`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`;
      await held;
    });
    try {
      const run = migrateDb(db);
      run.catch(() => undefined);
      await waitForLockWaiter();
      await relay.cut();

      // The query in flight loses its socket; the cleanup after it then
      // fails to reconnect (ECONNREFUSED) - and must not be what is thrown.
      await expect(run).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    } finally {
      release();
      await holder;
      await holderSql.end();
      // Not closeDb: its graceful end would wait for the dead relay.
      await db.$client.end({ timeout: 0 });
    }
  });

  /**
   * The unlock comes first and does not depend on restoring the session: a
   * failure of the latter must not leave the lock held by a live session.
   */
  it("releases the lock even when restoring client_min_messages fails", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const resetError = new Error("reset failed");
    const fault = failStep(db, "client_min_messages", resetError);
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
      expect(fault.hits).toBe(1);
      expect(await heldAdvisoryLocks(sql)).toBe(0);
      expect(onReleaseError).toHaveBeenCalledTimes(1);
      expect(onReleaseError).toHaveBeenCalledWith(
        "client_min_messages",
        resetError,
      );
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The migrations are applied; only the unlock after them failed. That is
   * not a failed run - the outcome comes back, the failure goes to the
   * callback, and closing the handle ends the lock with the session. Both
   * halves are read: the lock held while the handle is open - the unlock
   * really did not happen - and gone once it is closed; without the first
   * read the second could not fail.
   */
  it("returns the outcome when only the unlock fails, and reports the failure", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const unlockError = new Error("unlock failed");
    const fault = failStep(db, "unlock", unlockError);
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
      expect(fault.hits).toBe(1);
      expect(onReleaseError).toHaveBeenCalledTimes(1);
      expect(onReleaseError).toHaveBeenCalledWith("unlock", unlockError);
      expect(await heldAdvisoryLocks(sql)).toBe(1);
    } finally {
      await closeDb(db);
    }
    await expectNoAdvisoryLocks();
  });

  /**
   * The migrations are applied; only putting the timeouts back after them
   * failed. The step reaches `onReleaseError` by the name of the release
   * step, not by that of the restore right after the lock, which shares its
   * text.
   */
  it("returns the outcome when only the release step timeouts fails, and reports it by name", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const restoreError = new Error("restore failed");
    const fault = failStep(db, "timeouts", restoreError);
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
      expect(fault.hits).toBe(1);
      expect(onReleaseError).toHaveBeenCalledTimes(1);
      expect(onReleaseError).toHaveBeenCalledWith("timeouts", restoreError);
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      await closeDb(db);
    }
  });

  /**
   * A runner stuck while holding the lock: the next one gives up after its
   * wait with a message that says what is going on, instead of waiting
   * forever with an empty log (and the whole Compose stack behind it).
   */
  it("gives up waiting for a held lock with a message that says so", async () => {
    const second = createDb(TEST_DATABASE_URL, { max: 1 });
    const lock = await holdMigrationLock();
    // The driver prints a notice of the server with `console.log`: an
    // unlock of a lock the session never got would print a WARNING on the
    // stdout of the entry point, next to its one line. Restored in
    // `finally`, so a failed case leaves no spy behind.
    const printed = vi.spyOn(console, "log");
    try {
      // Its own wait and limit, which giving up must put back.
      await second.execute(drizzleSql`set lock_timeout = '7s'`);
      await second.execute(drizzleSql`set statement_timeout = '45s'`);

      const startedAt = Date.now();
      const run = migrateDb(second, { lockWaitMs: 300 });
      await expect(run).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      expect(
        printed.mock.calls
          .flat()
          .filter((arg) => JSON.stringify(arg)?.includes('"WARNING"')),
      ).toEqual([]);
      await expect(run).rejects.toMatchObject({
        waitMs: 300,
        message: migrationLockTimeoutMessage(300),
        cause: { code: "55P03" },
      });
      // The 300 ms are this runner's wait; the other one may have held the
      // lock far longer, and the message must not suggest otherwise.
      expect(migrationLockTimeoutMessage(300)).toMatch(
        /^another migration runner has held the migration lock for at least the 300 ms this one waited - /,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      lock.release();
      await expect(lock.stuck).resolves.toMatchObject({ applied: 0 });
      expect(await sessionSettings(second)).toEqual({
        lock_timeout: "7s",
        statement_timeout: "45s",
        client_min_messages: "notice",
      });
    } finally {
      printed.mockRestore();
      await lock.dispose();
      await closeDb(second);
    }
  });

  /**
   * Giving up on the lock runs two steps: `unlock` (a lock it never got:
   * nothing to do) and `timeouts`. When one fails, the failure reaches
   * `onReleaseError` by name instead of being dropped, the run still fails
   * with the busy lock - and the steps after it do not run: on a dead
   * connection each would only wait out the connect timeout and report a
   * consequence before the real failure.
   */
  it.each([
    ["unlock", ["read_session", "lock_wait", "lock", "unlock"]],
    ["timeouts", ["read_session", "lock_wait", "lock", "unlock", "timeouts"]],
  ] as const)(
    "reports a failed step %s after giving up on the lock and stops there",
    async (name, steps) => {
      const second = createDb(TEST_DATABASE_URL, { max: 1 });
      const lock = await holdMigrationLock();
      const restoreError = new Error("restore failed");
      const onReleaseError = vi.fn();
      try {
        const fault = failStep(second, name, restoreError);
        await expect(
          migrateDb(second, { lockWaitMs: 300, onReleaseError }),
        ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
        expect(fault.hits).toBe(1);
        expect(fault.steps).toEqual(steps);
        expect(onReleaseError).toHaveBeenCalledTimes(1);
        expect(onReleaseError).toHaveBeenCalledWith(name, restoreError);
      } finally {
        await lock.dispose();
        await closeDb(second);
      }
    },
  );

  /**
   * A handle whose own `statement_timeout` is shorter than the wait: the
   * wait runs with `statement_timeout` 0, so it is `lock_timeout` that ends
   * it - the busy lock after the whole `lockWaitMs`, not a cancel after the
   * session's 200 ms. The handle's own `statement_timeout` is back after.
   */
  it("waits the whole lockWaitMs for a busy lock even when the session's statement_timeout is shorter", async () => {
    const second = createDb(TEST_DATABASE_URL, { max: 1 });
    const lock = await holdMigrationLock();
    try {
      await second.execute(drizzleSql`set statement_timeout = '200ms'`);

      const run = migrateDb(second, { lockWaitMs: 800 });
      await expect(run).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      await expect(run).rejects.toMatchObject({
        waitMs: 800,
        message: migrationLockTimeoutMessage(800),
        cause: { code: "55P03" },
      });
      const timeout = await second.execute<{ statement_timeout: string }>(
        drizzleSql`show statement_timeout`,
      );
      expect(timeout[0]?.statement_timeout).toBe("200ms");
    } finally {
      await lock.dispose();
      await closeDb(second);
    }
  });

  /**
   * An operator cancels the waiting runner (`pg_cancel_backend`): that is a
   * cancel, not a busy lock - the driver's 57014 is thrown as it is, the
   * runner holds no lock afterwards and its session has its own settings.
   */
  it("throws a cancel of the wait as it is, not as a busy lock", async () => {
    const second = createDb(TEST_DATABASE_URL, { max: 1 });
    const lock = await holdMigrationLock();
    try {
      await second.execute(drizzleSql`set statement_timeout = '45s'`);
      const run = migrateDb(second, { lockWaitMs: 10_000 });
      run.catch(() => undefined);
      const waiter = await waitForAdvisoryWaiter(sql);
      await sql`SELECT pg_cancel_backend(${waiter})`;

      const failure: unknown = await run.catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(MigrationLockTimeoutError);
      expect(failure).toMatchObject({ code: "57014" });
      expect(await locksHeldBy(second)).toBe(0);
      expect(await sessionSettings(second)).toEqual({
        lock_timeout: "0",
        statement_timeout: "45s",
        client_min_messages: "notice",
      });
    } finally {
      await lock.dispose();
      await closeDb(second);
    }
  });

  /**
   * A cancel can land as the server grants the lock: `pg_advisory_lock`
   * fails, yet the session holds the lock. A failed attempt unlocks it before
   * it throws, or the lock would stay with a session the caller may keep.
   * Here the attempt is made to fail after it really ran.
   */
  it("releases a lock granted to an attempt that failed", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const cancel = Object.assign(
      new Error("canceling statement due to user request"),
      { code: "57014" },
    );
    const execute = db.execute.bind(db);
    let granted = 0;
    vi.spyOn(db, "execute").mockImplementation(
      (query) =>
        (async () => {
          const result = await execute(query);
          if (stepOf(query) === "lock") {
            granted += 1;
            throw cancel;
          }
          return result;
        })() as ReturnType<typeof execute>,
    );
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).rejects.toBe(cancel);
      expect(granted).toBe(1);
      // Read while the session is open: a lock it kept would still be held.
      expect(await locksHeldBy(db)).toBe(0);
      expect(onReleaseError).toHaveBeenCalledTimes(0);
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The caller's session took the migration lock itself before the run - a
   * long-lived handle that serialises its own work with the runners. The
   * lock is the session's own, not one granted to the failed attempt: the
   * attempt leaves it held, and still puts both timeouts back.
   */
  it("keeps a lock the session took before the run when the attempt fails", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const lockError = new Error("lock failed");
    const onReleaseError = vi.fn();
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set statement_timeout = '45s'`);
      await db.execute(
        drizzleSql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`,
      );
      const fault = failStep(db, "lock", lockError);

      await expect(migrateDb(db, { onReleaseError })).rejects.toBe(lockError);

      expect(fault.hits).toBe(1);
      expect(fault.steps).toEqual([
        "read_session",
        "lock_wait",
        "lock",
        "timeouts",
      ]);
      expect(await locksHeldBy(db)).toBe(1);
      expect(onReleaseError).toHaveBeenCalledTimes(0);
      expect(await sessionSettings(db)).toEqual({
        lock_timeout: "5s",
        statement_timeout: "45s",
        client_min_messages: "notice",
      });
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The same session, a run that succeeds: the run's own hold on the lock is
   * given back, the one the session took before it is not. A release that
   * dropped every hold of the session would leave 0 here.
   */
  it("keeps a lock the session took before the run when the run succeeds", async () => {
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    const onReleaseError = vi.fn();
    try {
      await db.execute(
        drizzleSql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`,
      );

      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });

      // Read while the session is open: closing it would drop the lock.
      expect(await locksHeldBy(db)).toBe(1);
      expect(onReleaseError).toHaveBeenCalledTimes(0);
    } finally {
      await closeDb(db);
    }
  });
});

describe("migrateDb on failure from an empty database", () => {
  /** A failed migration leaves the caller's session as it found it. */
  it("puts both session settings back when a migration fails", async () => {
    await emptyTestDatabase();
    // The first statement of 0000_core, already there: the migration fails.
    await sql`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set statement_timeout = '45s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      await expect(migrateDb(db)).rejects.toMatchObject({ code: "42710" });
      expect(await sessionSettings(db)).toEqual({
        lock_timeout: "5s",
        statement_timeout: "45s",
        client_min_messages: "error",
      });
    } finally {
      await closeDb(db);
      await resetTestDatabase();
    }
  });

  /**
   * The handle stays open after the failure - the session, and with it a lock
   * nobody released, would outlive the run that took it.
   */
  it("releases the lock when a migration fails", async () => {
    await emptyTestDatabase();
    // The first statement of 0000_core, already there: the migration fails.
    await sql`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await expect(migrateDb(db)).rejects.toMatchObject({ code: "42710" });
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      await closeDb(db);
      await resetTestDatabase();
    }
  });

  /**
   * A 57014 from inside the migration - the lock was free, a statement of
   * the migration waited past the session's `statement_timeout`, which is
   * back before the migration runs - is a slow migration, not a busy lock: it
   * is thrown as it is, and the operator is not sent after a runner that does
   * not exist.
   */
  it("throws a migration the session's statement_timeout cancelled as it is", async () => {
    await emptyTestDatabase();
    // An open transaction creates the type the first statement of 0000_core
    // creates: that statement waits on it until the timeout cancels it.
    let created: () => void = () => undefined;
    const typeCreated = new Promise<void>((done) => {
      created = done;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const holderSql = openTestSql();
    const holder = holderSql.begin(async (tx) => {
      await tx`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
      created();
      await held;
    });
    const db = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await typeCreated;
      await db.execute(drizzleSql`set statement_timeout = '200ms'`);

      const failure: unknown = await migrateDb(db, {
        lockWaitMs: 5_000,
      }).catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(MigrationLockTimeoutError);
      expect(failure).toMatchObject({ code: "57014" });
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      release();
      await holder;
      await holderSql.end();
      await closeDb(db);
      await resetTestDatabase();
    }
  });
});

/**
 * The real entry points on the test database: the handle they open must pass
 * migrateDb's single-connection check, or `pnpm db:migrate` and the Compose
 * `migrate` service fail before they take the lock.
 */
describe("the db:migrate entry point", () => {
  beforeEach(migrate);

  it("migrates through its own connection and exits with 0", async () => {
    const before = await testDatabaseSessions();
    const { out, err } = captureProcessOutput();
    let exitCode: typeof process.exitCode;
    try {
      await import("../src/cli/migrate.js");
      exitCode = process.exitCode;
    } finally {
      vi.restoreAllMocks();
      process.exitCode = undefined;
    }

    expect(err).toEqual([]);
    expect(out).toEqual([
      `migrations: nothing to apply, ${SHIPPED_MIGRATIONS} already applied\n`,
    ]);
    expect(exitCode).toBe(0);
    await expectEntryPointLeftNothing(before);
  });
});

describe("the migrate-and-seed entry point", () => {
  /**
   * From an empty database, whatever ran before; the module runs on import,
   * so it is loaded afresh - a cached one would run nothing on a retry.
   */
  it("migrates an empty database and seeds it through its own connection, exiting with 0", async () => {
    await emptyTestDatabase();
    vi.resetModules();
    const before = await testDatabaseSessions();
    const { out, err } = captureProcessOutput();
    let exitCode: typeof process.exitCode;
    try {
      await import("../src/cli/migrate-and-seed.js");
      exitCode = process.exitCode;
    } finally {
      vi.restoreAllMocks();
      process.exitCode = undefined;
    }

    try {
      expect(err).toEqual([]);
      expect(out).toEqual([
        `migrations: applied ${SHIPPED_MIGRATIONS}, ${SHIPPED_MIGRATIONS} in total\n`,
        "app settings seeded\n",
      ]);
      expect(exitCode).toBe(0);
      await expectEntryPointLeftNothing(before);
    } finally {
      await resetTestDatabase();
    }
  });
});

describe("the advisory lock helpers of the test support", () => {
  /**
   * The entry check of this run holds the run lock on a session of its own
   * through every file; the cases that read "no lock left" mean the locks
   * of the migration runner. Left out is that key only, not every lock of
   * another session.
   */
  it("leaves out the run lock another session holds, and that key only", async () => {
    const runLocks = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = ${RUN_LOCK_KEY}::bigint
        AND pid <> pg_backend_pid()
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    expect(runLocks[0]?.n).toBe(1);

    expect(await heldAdvisoryLocks(sql)).toBe(0);

    const other = openTestSql();
    try {
      await other`SELECT pg_advisory_lock(${RUN_LOCK_KEY + 1}::bigint)`;
      expect(await heldAdvisoryLocks(sql)).toBe(1);
    } finally {
      await other.end();
      // The server ends the closed session on its own time; the next case
      // reads no lock at all.
      await vi.waitFor(async () => {
        expect(await heldAdvisoryLocks(sql)).toBe(0);
      });
    }
  });

  /** A lock on another database of the same server is not this test's. */
  it("does not count an advisory lock held on another database", async () => {
    const other = openMaintenanceSql();
    try {
      await other`SELECT pg_advisory_lock(42)`;
      expect(await heldAdvisoryLocks(sql)).toBe(0);
    } finally {
      await other.end();
    }
  });

  /**
   * A session waiting for an advisory lock on another database - a runner
   * on the dev database - is not a waiter of this test: a case would cancel
   * it by the pid it was given.
   */
  it("does not take a session waiting on another database for a waiter", async () => {
    const holder = openMaintenanceSql();
    const waiter = openMaintenanceSql();
    let waiting: Promise<void> = Promise.resolve();
    try {
      await holder`SELECT pg_advisory_lock(42)`;
      waiting = waiter`SELECT pg_advisory_lock(42)`.then(
        () => undefined,
        () => undefined,
      );
      await vi.waitFor(async () => {
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = 'postgres')`;
        expect(rows[0]?.n).toBe(1);
      });

      await expect(waitForAdvisoryWaiter(sql, 300)).rejects.toThrow(
        "no session started waiting for an advisory lock",
      );
    } finally {
      // The holder ends first: its session going frees the lock the waiter
      // is stuck on, so the waiting query settles before the waiter closes.
      await holder.end();
      await waiting;
      await waiter.end();
    }
  });
});

/** Polls until a session waits for the journal table, at most five seconds. */
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE relation = 'drizzle.__drizzle_migrations'::regclass AND NOT granted
    `;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("no session started waiting for the migration journal");
}
