import { readFileSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { env } from "@sf/config";
import { type SQLWrapper, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, closeDb, createDb } from "../src/client.js";
import {
  MIGRATE_NEEDS_SINGLE_CONNECTION,
  MIGRATION_LOCK_WAIT_MS,
  migrateDb,
  migrationLockTimeoutMessage,
  runMigrations,
} from "../src/migrate.js";
import {
  emptyTestDatabase,
  openTestSql,
  resetTestDatabase,
} from "./helpers.int.js";

/** Migrations the repository ships, read from drizzle's own journal. */
const SHIPPED_MIGRATIONS = (
  JSON.parse(
    readFileSync(
      new URL("../migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: unknown[] }
).entries.length;

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

const sql = openTestSql();

/**
 * Advisory locks granted to any session of the test database right now.
 * `pg_locks` covers the whole server: a `pnpm db:migrate` or the Compose
 * `migrate` service holding its lock on the dev database must not count here.
 */
async function heldAdvisoryLocks(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  return rows[0]?.n ?? -1;
}

/** The text of a drizzle query, to pick out the statements of the release. */
const dialect = new PgDialect();
function queryText(query: SQLWrapper | string): string {
  return typeof query === "string"
    ? query
    : dialect.sqlToQuery(query.getSQL()).sql;
}

/**
 * Makes the statements of `db` whose text contains `fragment` fail, and lets
 * every other one - drizzle's migrator does not go through `execute` - reach
 * the database.
 */
function failStatements(db: Db, fragment: string, error: Error): void {
  const execute = db.execute.bind(db);
  vi.spyOn(db, "execute").mockImplementation((query) =>
    queryText(query).includes(fragment)
      ? (Promise.reject(error) as ReturnType<typeof execute>)
      : execute(query),
  );
}

/**
 * Makes only the `nth` statement of `db` (counting from 1) whose text contains
 * `fragment` fail; every other one, the earlier and later matches included,
 * reaches the database.
 */
function failNthStatement(
  db: Db,
  fragment: string,
  nth: number,
  error: Error,
): void {
  const execute = db.execute.bind(db);
  let seen = 0;
  vi.spyOn(db, "execute").mockImplementation((query) => {
    if (queryText(query).includes(fragment)) {
      seen += 1;
      if (seen === nth) {
        return Promise.reject(error) as ReturnType<typeof execute>;
      }
    }
    return execute(query);
  });
}

/** One statement of `migrateDb` and the session's lock_timeout right after it. */
interface ObservedStatement {
  text: string;
  /** `pg_settings.setting`: milliseconds, "0" for "wait forever". */
  lockTimeoutMs: string;
}

/**
 * Records, after every statement `db` runs through `execute`, the
 * `lock_timeout` of its session. The handle has one connection, so the probe
 * reads the very session the statement ran on.
 */
function observeLockTimeout(db: Db): ObservedStatement[] {
  const observed: ObservedStatement[] = [];
  const execute = db.execute.bind(db);
  const probe = drizzleSql`select setting from pg_settings where name = 'lock_timeout'`;
  vi.spyOn(db, "execute").mockImplementation(
    (query) =>
      (async () => {
        const result = await execute(query);
        const rows = await execute(probe);
        const setting = rows[0]?.setting;
        observed.push({
          text: queryText(query),
          lockTimeoutMs: typeof setting === "string" ? setting : "",
        });
        return result;
      })() as ReturnType<typeof execute>,
  );
  return observed;
}

/** The observed statements that run while `migrateDb` holds the lock. */
function underTheLock(observed: ObservedStatement[]): ObservedStatement[] {
  const locked = observed.findIndex((s) =>
    s.text.includes("pg_advisory_lock("),
  );
  const unlocked = observed.findIndex((s) =>
    s.text.includes("pg_advisory_unlock("),
  );
  if (locked < 0 || unlocked < locked) {
    throw new Error("migrateDb did not take and release its lock");
  }
  return observed.slice(locked + 1, unlocked);
}

/**
 * A TCP relay in front of the test Postgres that can be pulled out: `cut()`
 * stops listening and drops every relayed socket, so the client's next
 * reconnect is refused - the "database went away" a migration can meet.
 */
async function openRelay(): Promise<{ url: string; cut: () => Promise<void> }> {
  const target = new URL(env.DATABASE_URL);
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port),
    });
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("relay has no port");
  }
  const url = new URL(env.DATABASE_URL);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    cut: async () => {
      const closed = new Promise<void>((done) => server.close(() => done()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("runMigrations", () => {
  it("creates every table of System Design §5 on an empty database", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual(TABLES_SECTION_5);
  });

  it("is idempotent: a second run applies nothing and does not fail", async () => {
    await expect(runMigrations(env.DATABASE_URL)).resolves.toBeUndefined();

    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    expect(rows).toHaveLength(TABLES_SECTION_5.length);
  });
});

describe("migrateDb", () => {
  /**
   * The Compose `migrate` service and a developer's `pnpm db:migrate` can
   * start together. drizzle reads its journal before its transaction, so
   * without the advisory lock both runners see an empty journal and the second
   * fails on `CREATE TYPE ... already exists`.
   */
  it("serialises two runners started together on an empty database", async () => {
    await emptyTestDatabase();
    const first = createDb(env.DATABASE_URL, { max: 1 });
    const second = createDb(env.DATABASE_URL, { max: 1 });

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

  it("waits for the lock at most MIGRATION_LOCK_WAIT_MS by default", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
    const observed = observeLockTimeout(db);
    try {
      await migrateDb(db);
    } finally {
      await closeDb(db);
    }

    const lock = observed.find((s) => s.text.includes("pg_advisory_lock("));
    expect(lock?.lockTimeoutMs).toBe(String(MIGRATION_LOCK_WAIT_MS));
  });

  /**
   * The wait is for the advisory lock only: left in place, it would also cut
   * short every statement of the migration that waits for a table lock.
   */
  it("runs the migration under the session's own lock_timeout", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
    const observed = observeLockTimeout(db);
    let before = "";
    try {
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
  });

  it("reports nothing to apply on a current database", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
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

describe("migrateDb on failure", () => {
  /**
   * `lock_timeout` 0 is "wait forever" - the hang the wait exists to prevent;
   * a fraction or NaN would reach Postgres as a raw error.
   */
  it.each([0, Number.NaN, -1, 1.5])(
    "refuses lockWaitMs %s before its first query",
    async (lockWaitMs) => {
      const db = createDb(env.DATABASE_URL, { max: 1 });
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

  it("refuses a pooled handle before it takes the lock", async () => {
    const pooled = createDb(env.DATABASE_URL);
    try {
      await expect(migrateDb(pooled)).rejects.toThrow(
        MIGRATE_NEEDS_SINGLE_CONNECTION,
      );
    } finally {
      await closeDb(pooled);
    }
    expect(await heldAdvisoryLocks()).toBe(0);
  });

  it("restores client_min_messages of the handle it was given", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
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
    const db = createDb(env.DATABASE_URL, { max: 1 });
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      await migrateDb(db);
      const rows = await db.execute<{
        lock_timeout: string;
        client_min_messages: string;
      }>(
        drizzleSql`select current_setting('lock_timeout') as lock_timeout, current_setting('client_min_messages') as client_min_messages`,
      );
      expect(rows[0]).toEqual({
        lock_timeout: "5s",
        client_min_messages: "error",
      });
    } finally {
      await closeDb(db);
    }
  });

  /** A failed migration leaves the caller's session as it found it. */
  it("puts both session settings back when a migration fails", async () => {
    await emptyTestDatabase();
    // The first statement of 0000_core, already there: the migration fails.
    await sql`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
    const db = createDb(env.DATABASE_URL, { max: 1 });
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      await expect(migrateDb(db)).rejects.toMatchObject({ code: "42710" });
      const rows = await db.execute<{
        lock_timeout: string;
        client_min_messages: string;
      }>(
        drizzleSql`select current_setting('lock_timeout') as lock_timeout, current_setting('client_min_messages') as client_min_messages`,
      );
      expect(rows[0]).toEqual({
        lock_timeout: "5s",
        client_min_messages: "error",
      });
    } finally {
      await closeDb(db);
      await resetTestDatabase();
    }
  });

  /**
   * The run fails on its first statement under the lock - putting the
   * session's own lock_timeout back after the wait (the first `set_config` of
   * it sets the wait, the second restores). The release must restore it again:
   * otherwise the caller's handle silently keeps the run's wait.
   */
  it("puts lock_timeout back when restoring it after the lock fails", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
    const restoreError = new Error("restore failed");
    try {
      await db.execute(drizzleSql`set lock_timeout = '5s'`);
      await db.execute(drizzleSql`set client_min_messages = error`);
      failNthStatement(db, "set_config('lock_timeout'", 2, restoreError);
      await expect(migrateDb(db, { lockWaitMs: 300 })).rejects.toBe(
        restoreError,
      );
      const rows = await db.execute<{
        lock_timeout: string;
        client_min_messages: string;
      }>(
        drizzleSql`select current_setting('lock_timeout') as lock_timeout, current_setting('client_min_messages') as client_min_messages`,
      );
      expect(rows[0]).toEqual({
        lock_timeout: "5s",
        client_min_messages: "error",
      });
      expect(await heldAdvisoryLocks()).toBe(0);
    } finally {
      await closeDb(db);
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
    const db = createDb(env.DATABASE_URL, { max: 1 });
    try {
      await expect(migrateDb(db)).rejects.toMatchObject({ code: "42710" });
      expect(await heldAdvisoryLocks()).toBe(0);
    } finally {
      await closeDb(db);
      await resetTestDatabase();
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
    const db = createDb(env.DATABASE_URL, { max: 1 });
    const resetError = new Error("reset failed");
    failStatements(db, "set_config('client_min_messages'", resetError);
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
      expect(await heldAdvisoryLocks()).toBe(0);
      expect(onReleaseError).toHaveBeenCalledTimes(1);
      expect(onReleaseError).toHaveBeenCalledWith(resetError);
    } finally {
      await closeDb(db);
    }
  });

  /**
   * The migrations are applied; only the unlock after them failed. That is
   * not a failed run - the outcome comes back, the failure goes to the
   * callback, and closing the handle ends the lock with the session.
   */
  it("returns the outcome when only the unlock fails, and reports the failure", async () => {
    const db = createDb(env.DATABASE_URL, { max: 1 });
    const unlockError = new Error("unlock failed");
    failStatements(db, "pg_advisory_unlock", unlockError);
    const onReleaseError = vi.fn();
    try {
      await expect(migrateDb(db, { onReleaseError })).resolves.toEqual({
        applied: 0,
        total: SHIPPED_MIGRATIONS,
      });
      expect(onReleaseError).toHaveBeenCalledTimes(1);
      expect(onReleaseError).toHaveBeenCalledWith(unlockError);
    } finally {
      await closeDb(db);
    }
    expect(await heldAdvisoryLocks()).toBe(0);
  });

  /**
   * A runner stuck while holding the lock: the next one gives up after its
   * wait with a message that says what is going on, instead of waiting
   * forever with an empty log (and the whole Compose stack behind it).
   */
  it("gives up waiting for a held lock with a message that says so", async () => {
    const first = createDb(env.DATABASE_URL, { max: 1 });
    const second = createDb(env.DATABASE_URL, { max: 1 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    // Keeps the first runner inside its migration, holding the lock.
    const holderSql = openTestSql();
    const holder = holderSql.begin(async (tx) => {
      await tx`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`;
      await held;
    });
    try {
      const stuck = migrateDb(first);
      stuck.catch(() => undefined);
      await waitForLockWaiter();
      // Its own wait, which giving up must put back.
      await second.execute(drizzleSql`set lock_timeout = '7s'`);

      const startedAt = Date.now();
      await expect(migrateDb(second, { lockWaitMs: 300 })).rejects.toThrow(
        migrationLockTimeoutMessage(300),
      );
      // The 300 ms are this runner's wait; the other one may have held the
      // lock far longer, and the message must not suggest otherwise.
      expect(migrationLockTimeoutMessage(300)).toMatch(
        /^another migration runner has held the migration lock for at least the 300 ms this one waited - /,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      release();
      await expect(stuck).resolves.toMatchObject({ applied: 0 });
      const timeout = await second.execute<{ lock_timeout: string }>(
        drizzleSql`show lock_timeout`,
      );
      expect(timeout[0]?.lock_timeout).toBe("7s");
    } finally {
      release();
      await holder;
      await holderSql.end();
      await closeDb(first);
      await closeDb(second);
    }
  });
});

/**
 * The real entry point on the test database: the handle it opens must pass
 * migrateDb's single-connection check, or `pnpm db:migrate` and the Compose
 * `migrate` service fail before they take the lock.
 */
describe("the db:migrate entry point", () => {
  it("migrates through its own connection and exits with 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
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
    expect(await heldAdvisoryLocks()).toBe(0);
  });
});

describe("heldAdvisoryLocks", () => {
  /** A lock on another database of the same server is not this test's. */
  it("does not count an advisory lock held on another database", async () => {
    const url = new URL(env.DATABASE_URL);
    url.pathname = "/postgres";
    const other = postgres(url.toString(), { max: 1 });
    try {
      await other`SELECT pg_advisory_lock(42)`;
      expect(await heldAdvisoryLocks()).toBe(0);
    } finally {
      await other.end();
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
