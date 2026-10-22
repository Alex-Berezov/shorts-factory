import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSession } from "../test-support/other-sessions.js";

/**
 * The fixture in front of the integration suites, without a database: the
 * environment and the driver are stand-ins, so what is checked is the order -
 * the guard before any client exists - and what `assertMigrated` makes of the
 * answers it gets. With Compose up these paths are never taken: the guard
 * always passes and the database is always there.
 */
const LOCAL_DB = "postgresql://sf:sf@localhost:5442/shorts_factory_test";
const LOCAL_REDIS = "redis://localhost:6389/1";

const stub = vi.hoisted(() => {
  /** What the stand-in client answers to a query, by the query's text. */
  type Answer = (text: string) => Promise<unknown>;
  const state = {
    env: { DATABASE_URL: "", REDIS_URL: "" },
    answer: (async () => []) as Answer,
    opened: 0,
    ended: 0,
    /** The text of every query, in order. */
    queries: [] as string[],
    /** The client `postgres()` handed out last. */
    last: undefined as unknown,
    /** The options `postgres()` was called with, one entry per call. */
    options: [] as unknown[],
    /** The url `postgres()` was called with, one entry per call. */
    urls: [] as string[],
    /** How many times the setup file of the thin configs was loaded since a case reset it. */
    setupLoaded: 0,
    /** What `end()` of every client rejects with, undefined for an end that succeeds. */
    endError: undefined as Error | undefined,
  };
  function fakeClient(url: string, options?: unknown): unknown {
    state.opened += 1;
    state.options.push(options);
    state.urls.push(url);
    const query = (text: string): Promise<unknown> => {
      state.queries.push(text);
      return state.answer(text);
    };
    const sql = (strings: TemplateStringsArray) => query(strings.join("?"));
    state.last = sql;
    return Object.assign(sql, {
      end: async () => {
        state.ended += 1;
        if (state.endError !== undefined) throw state.endError;
      },
      // What a drizzle query (`db.execute`, `tableExists`) runs its text with.
      unsafe: (text: string) => query(text),
      // What drizzle's postgres-js driver touches when it wraps a client.
      options: { parsers: {}, serializers: {} },
    });
  }
  return { state, fakeClient };
});

vi.mock("@sf/config", () => ({ env: stub.state.env }));
vi.mock("postgres", () => ({ default: stub.fakeClient }));
// The real setup file loads `.env.test`; the cases that count its loads
// register their own stand-in (`vi.doMock`).
vi.mock("@sf/config/vitest/setup", () => ({}));

const {
  assertMigrated,
  emptyTestDatabase,
  openTestDb,
  openTestSql,
  useTestDb,
} = await import("../test-support/fixture.js");

const postgresEntryCheck = await import(
  "../test-support/entry-check/postgres.js"
);
const migratedStackEntryCheck = await import(
  "../test-support/entry-check/migrated-stack.js"
);

const sessionCheck = await import("../test-support/other-sessions.js");

const { migrationsFolder } = await import("../src/migrate.js");
const MIGRATIONS = readMigrationFiles({ migrationsFolder });

/**
 * The answer to a query of the run lock (`../test-support/run-lock.ts`),
 * undefined for any other query: free by default - taken, then let go - or
 * held by `holders`, the rows of `pg_locks` joined with `pg_stat_activity`.
 * Asked first: the query of the holders names `pg_stat_activity` too.
 */
function runLockAnswer(
  text: string,
  lock: { taken: unknown; holders?: unknown[] } = { taken: true },
): unknown[] | undefined {
  if (text.includes("pg_try_advisory_lock")) return [{ taken: lock.taken }];
  if (text.includes("pg_advisory_unlock")) return [{ released: true }];
  if (text.includes("pg_locks")) return lock.holders ?? [];
  return undefined;
}

/**
 * Answers of a database that carries `rows` in its drizzle journal, with
 * `sessions` of other clients on it (`pg_stat_activity`), none by default,
 * and the run lock free.
 */
function databaseWith(
  rows: { createdAt: string; hash: string }[],
  sessions: unknown[] = [],
) {
  return async (text: string): Promise<unknown> => {
    const lock = runLockAnswer(text);
    if (lock !== undefined) return lock;
    if (text.includes("pg_stat_activity")) return sessions;
    return text.includes("to_regclass") ? [{ present: true }] : rows;
  };
}

/** Whether the session check read `pg_stat_activity` (its query, not the one of the lock holders). */
const readSessions = (): boolean =>
  stub.state.queries.some((query) => query.includes("backend_type"));

/** Whether the run lock was let go by its query, not only by a closed client. */
const unlocked = (): boolean =>
  stub.state.queries.some((query) => query.includes("pg_advisory_unlock"));

/** The journal of a database `packages/db/migrations` is applied to. */
const migrated = () =>
  MIGRATIONS.map((m) => ({
    createdAt: String(m.folderMillis),
    hash: m.hash,
  }));

beforeEach(() => {
  stub.state.env.DATABASE_URL = LOCAL_DB;
  stub.state.env.REDIS_URL = LOCAL_REDIS;
  stub.state.answer = databaseWith(migrated());
  stub.state.opened = 0;
  stub.state.ended = 0;
  stub.state.queries = [];
  stub.state.last = undefined;
  stub.state.options = [];
  stub.state.urls = [];
  stub.state.endError = undefined;
});

// An entry check that passed holds the run lock in its module until its
// teardown; a case that does not let it go must not hand it to the next.
afterEach(async () => {
  stub.state.answer = databaseWith(migrated());
  stub.state.endError = undefined;
  await postgresEntryCheck.teardown();
  await migratedStackEntryCheck.teardown();
});

describe("the fixture checks the stack before it opens anything", () => {
  it.each<[string, () => unknown]>([
    ["openTestSql", () => openTestSql()],
    ["openTestDb", () => openTestDb()],
    ["emptyTestDatabase", () => emptyTestDatabase()],
    ["assertMigrated", () => assertMigrated()],
  ])("%s refuses a Postgres on another machine", async (_name, call) => {
    stub.state.env.DATABASE_URL =
      "postgresql://sf:sf@db.example.com:5442/shorts_factory_test";
    // What a call that got through returns is not shown: a drizzle handle
    // is too large to print.
    const outcome = Promise.resolve()
      .then(call)
      .then(() => "opened");
    await expect(outcome).rejects.toThrow(/host "db\.example\.com"/);
    expect(stub.state.opened).toBe(0);
  });

  it("asks a Postgres helper about Postgres only", () => {
    // A Postgres-only run does not fail on the Redis half of `.env.test`.
    stub.state.env.REDIS_URL = "redis://redis.example.com:6389/1";
    const sql = openTestSql();
    expect(sql).toBe(stub.state.last);
    expect(stub.state.opened).toBe(1);
  });

  it("opens the raw client with the options of the service client, one connection", () => {
    // The bound on a connection attempt is the one `createDb` sets; the raw
    // client is opened apart from it only to keep the driver's own parsers.
    openTestSql();
    expect(stub.state.options).toEqual([{ max: 1, connect_timeout: 10 }]);
  });

  it("checks Redis too in assertMigrated, the entry check of a suite", async () => {
    // The worker suite forks processes that read REDIS_URL as is.
    stub.state.env.REDIS_URL = "redis://localhost:6389/0";
    await expect(assertMigrated()).rejects.toThrow(/redis database "0"/);
    expect(stub.state.opened).toBe(0);
  });
});

describe("emptyTestDatabase", () => {
  /** Answers `current_database()` with `name`, everything else with nothing. */
  function serverConnectedTo(name: string) {
    return async (text: string): Promise<unknown> =>
      text.includes("current_database()") ? [{ name }] : [];
  }

  it("asks the server which database it is connected to before it drops anything", async () => {
    // The URL can name the test database while the server says otherwise -
    // a proxy, a rewrite: the answer of the server is what `DROP SCHEMA` hits.
    stub.state.answer = serverConnectedTo("shorts_factory");
    await expect(emptyTestDatabase()).rejects.toThrow(
      /database "shorts_factory".*"shorts_factory_test"/,
    );
    expect(stub.state.queries.filter((q) => /DROP|CREATE/.test(q))).toEqual([]);
    expect(stub.state.ended).toBe(1);
  });

  it("drops both schemas of the test database", async () => {
    stub.state.answer = serverConnectedTo("shorts_factory_test");
    await emptyTestDatabase();
    expect(stub.state.queries.map((q) => q.trim())).toEqual([
      "SELECT current_database() AS name",
      "DROP SCHEMA IF EXISTS public CASCADE",
      "CREATE SCHEMA public",
      "DROP SCHEMA IF EXISTS drizzle CASCADE",
    ]);
    expect(stub.state.ended).toBe(1);
  });
});

describe("assertMigrated", () => {
  it("lets a database migrated to the folder through, and closes its client", async () => {
    await expect(assertMigrated()).resolves.toBeUndefined();
    expect(stub.state.opened).toBe(1);
    expect(stub.state.ended).toBe(1);
  });

  it("refuses a migration whose file was edited after it was applied", async () => {
    stub.state.answer = databaseWith(
      MIGRATIONS.map((m) => ({
        createdAt: String(m.folderMillis),
        hash: "0".repeat(64),
      })),
    );
    await expect(assertMigrated()).rejects.toThrow(
      new RegExp(
        `edited after it was applied: ${MIGRATIONS[0]?.folderMillis}.*pnpm db:migrate`,
      ),
    );
    expect(stub.state.ended).toBe(1);
  });

  it("refuses a database with no migrations at all", async () => {
    stub.state.answer = async () => [{ present: false }];
    // Every migration of the folder, however many there are.
    const all = MIGRATIONS.map((m) => String(m.folderMillis)).join(", ");
    await expect(assertMigrated()).rejects.toThrow(
      `(missing: ${all}; not in the folder: none;`,
    );
  });

  it("names Compose and .env.test when the database cannot be reached", async () => {
    stub.state.answer = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5442"), {
        code: "ECONNREFUSED",
      });
    };
    await expect(assertMigrated()).rejects.toThrow(
      /localhost:5442 \(ECONNREFUSED\).*docker compose -f infra\/docker-compose\.yml up -d.*\.env\.test/,
    );
    expect(stub.state.ended).toBe(1);
  });

  it("names the address it read, and no Compose hint for an answer of a server", async () => {
    // A wrong password is a server that is up: starting Compose is not the fix.
    stub.state.env.DATABASE_URL =
      "postgresql://sf:sf@127.0.0.1:5442/shorts_factory_test";
    stub.state.answer = async () => {
      throw Object.assign(new Error("password authentication failed"), {
        code: "28P01",
      });
    };
    const error = await assertMigrated().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(String(error)).toMatch(
      /cannot read the migrations of the test database on 127\.0\.0\.1:5442 \(28P01\)$/,
    );
    expect(String(error)).not.toContain("docker compose");
  });
});

describe("useTestDb", () => {
  /** File hooks that run when the case says so. */
  function fileHooks() {
    const before: (() => Promise<void>)[] = [];
    const after: (() => Promise<void>)[] = [];
    return {
      hooks: {
        beforeAll: (fn: () => Promise<void>) => {
          before.push(fn);
        },
        afterAll: (fn: () => Promise<void>) => {
          after.push(fn);
        },
      },
      runBefore: async () => {
        for (const fn of before) await fn();
      },
      runAfter: async () => {
        for (const fn of after) await fn();
      },
    };
  }

  it("opens the handle after preparing the database, and closes it after the file", async () => {
    const file = fileHooks();
    const prepare = vi.fn(async () => {
      expect(stub.state.opened).toBe(0);
    });
    const db = useTestDb(file.hooks, { prepare });

    await file.runBefore();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(stub.state.opened).toBe(1);
    expect(db().$client).toBe(stub.state.last);

    await file.runAfter();
    expect(stub.state.ended).toBe(1);
    expect(() => db()).toThrow(/test database is not open/);
  });

  it("closes nothing and throws nothing after a beforeAll that failed", async () => {
    const file = fileHooks();
    const db = useTestDb(file.hooks, {
      prepare: async () => {
        throw new Error("database is down");
      },
    });

    await expect(file.runBefore()).rejects.toThrow("database is down");
    await expect(file.runAfter()).resolves.toBeUndefined();
    expect(stub.state.opened).toBe(0);
    expect(stub.state.ended).toBe(0);
    expect(() => db()).toThrow(/test database is not open/);
  });

  it("closes the handle when the cleanup before closing fails", async () => {
    const file = fileHooks();
    useTestDb(file.hooks, {
      prepare: async () => undefined,
      beforeClose: async () => {
        throw new Error("delete failed");
      },
    });

    await file.runBefore();
    await expect(file.runAfter()).rejects.toThrow("delete failed");
    expect(stub.state.ended).toBe(1);
  });
});

describe("the entry checks of the integration runs", () => {
  it.each<[string, () => Promise<unknown>]>([
    ["postgres", () => import("../test-support/entry-check/postgres.js")],
    [
      "migrated-stack",
      () => import("../test-support/entry-check/migrated-stack.js"),
    ],
  ])(
    "%s loads the setup file of the thin configs: it checks what the files will see",
    async (_name, load) => {
      // Each check on its own, from a fresh module graph: one counter over
      // both stays green when only one of them stops loading the file.
      vi.resetModules();
      stub.state.setupLoaded = 0;
      vi.doMock("@sf/config/vitest/setup", () => {
        stub.state.setupLoaded += 1;
        return {};
      });
      await load();
      expect(stub.state.setupLoaded).toBe(1);
    },
  );

  it("postgres refuses a Postgres on another machine, before any client", async () => {
    stub.state.env.DATABASE_URL =
      "postgresql://sf:sf@db.example.com:5442/shorts_factory_test";
    await expect(postgresEntryCheck.setup()).rejects.toThrow(
      /host "db\.example\.com"/,
    );
    expect(stub.state.opened).toBe(0);
  });

  it("postgres does not look at Redis: the db suite does not touch it", async () => {
    stub.state.env.REDIS_URL = "redis://redis.example.com:6389/1";
    await expect(postgresEntryCheck.setup()).resolves.toBeUndefined();
    // Postgres clients only: the run lock, held, and the session check, closed.
    expect(stub.state.opened).toBe(2);
    expect(stub.state.ended).toBe(1);
  });

  it.each<[string, () => Promise<void>, () => Promise<void>]>([
    [
      "postgres",
      () => postgresEntryCheck.setup(),
      () => postgresEntryCheck.teardown(),
    ],
    [
      "migrated-stack",
      () => migratedStackEntryCheck.setup(),
      () => migratedStackEntryCheck.teardown(),
    ],
  ])(
    "%s takes the run lock before any other read, holds it through the run and lets it go at teardown",
    async (_name, setup, teardown) => {
      await setup();
      expect(stub.state.queries[0]).toContain("pg_try_advisory_lock");
      expect(readSessions()).toBe(true);
      // The client of the lock is the one still open.
      expect(stub.state.ended).toBe(stub.state.opened - 1);
      expect(unlocked()).toBe(false);

      await teardown();
      expect(unlocked()).toBe(true);
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it.each<[string, () => Promise<void>]>([
    ["postgres", () => postgresEntryCheck.setup()],
    ["migrated-stack", () => migratedStackEntryCheck.setup()],
  ])(
    "%s refuses a run lock another run holds, naming its holder, and reads nothing else",
    async (_name, setup) => {
      stub.state.answer = async (text) =>
        runLockAnswer(text, {
          taken: false,
          holders: [
            {
              pid: 777,
              applicationName: "sf-session-check",
              backendStart: "2026-10-22 10:00:00+00",
            },
          ],
        }) ?? [{ present: true }];

      await expect(setup()).rejects.toThrow(
        'another integration run holds the run lock of the test database shorts_factory_test: pid=777 application_name="sf-session-check" backend_start=2026-10-22 10:00:00+00; a second run would reset the database under the first. Wait for it to finish, then run again. A run that hangs is ended by its own process first (Ctrl+C in its terminal, or the vitest/turbo process it runs in); its sessions go with it. Only a session whose process is already gone is ended by its pid - on a run that is still alive this drops its barrier and lets the next run reset the database under it: docker compose -f infra/docker-compose.yml exec postgres psql -U sf -d shorts_factory_test -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (777)"',
      );
      expect(readSessions()).toBe(false);
      expect(
        stub.state.queries.some((query) => query.includes("to_regclass")),
      ).toBe(false);
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it("refuses a run lock whose holder left before it was named, as taken all the same", async () => {
    stub.state.answer = async (text) =>
      runLockAnswer(text, { taken: false, holders: [] }) ?? [];

    await expect(postgresEntryCheck.setup()).rejects.toThrow(
      "another integration run holds the run lock of the test database shorts_factory_test - its holder left before it could be named",
    );
    expect(readSessions()).toBe(false);
  });

  it("throws an answer of the lock of another shape as it is, not as a lock that is free", async () => {
    stub.state.answer = async (text) =>
      runLockAnswer(text, { taken: "t" }) ?? [];

    await expect(postgresEntryCheck.setup()).rejects.toThrow(
      'pg_try_advisory_lock gave a row the run lock cannot read: {"taken":"t"}',
    );
    expect(readSessions()).toBe(false);
    expect(stub.state.ended).toBe(stub.state.opened);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a pid that is text",
      { pid: "777", applicationName: "x", backendStart: null },
    ],
    [
      "a pid that is no whole number",
      { pid: 7.5, applicationName: "x", backendStart: null },
    ],
    ["no application name", { pid: 777, backendStart: null }],
    [
      "a start that is a number",
      { pid: 777, applicationName: "x", backendStart: 0 },
    ],
  ])(
    "throws a holder of the lock with %s as it is, not as a holder it names",
    async (_name, holder) => {
      stub.state.answer = async (text) =>
        runLockAnswer(text, { taken: false, holders: [holder] }) ?? [];

      const refusal = postgresEntryCheck.setup();

      await expect(refusal).rejects.toThrow(
        `pg_locks gave a row the run lock cannot read: ${JSON.stringify(holder)}`,
      );
      await expect(refusal).rejects.not.toThrow(/another integration run/);
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it("names a holder it cannot date as such, and still by its pid", async () => {
    stub.state.answer = async (text) =>
      runLockAnswer(text, {
        taken: false,
        holders: [
          { pid: 777, applicationName: "sf-session-check", backendStart: null },
        ],
      }) ?? [];

    const refusal = postgresEntryCheck.setup();

    await expect(refusal).rejects.toThrow(
      'pid=777 application_name="sf-session-check" backend_start=unknown;',
    );
    await expect(refusal).rejects.toThrow("WHERE pid IN (777)");
  });

  it("names a database that took the connection and never answered the run lock: the limit of the probe, with Compose", async () => {
    const { limitMs } = sessionCheck.SESSION_CHECK_BOUNDS;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A paused container: the query is sent and nothing comes back.
      stub.state.answer = () => new Promise<never>(() => undefined);

      const refusal = postgresEntryCheck.setup();
      const checked = Promise.all([
        expect(refusal).rejects.toThrow(
          `the test database on localhost:5442 did not answer within ${limitMs} ms reading the run lock (PROBE_LIMIT) - is the local Compose stack up`,
        ),
        expect(refusal).rejects.not.toThrow(/cannot read/),
      ]);
      await vi.advanceTimersByTimeAsync(limitMs);
      await checked;
      expect(readSessions()).toBe(false);
      // The client the limit gave up on and the fresh one after it, both ended.
      expect(stub.state.ended).toBe(stub.state.opened);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a run lock the server cut at its statement_timeout as a database that did not answer, not as one it cannot reach", async () => {
    const { statementTimeoutMs } = sessionCheck.SESSION_CHECK_BOUNDS;
    stub.state.answer = async () => {
      throw Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" },
      );
    };

    const refusal = postgresEntryCheck.setup();

    await expect(refusal).rejects.toThrow(
      `the test database on localhost:5442 did not answer within ${statementTimeoutMs} ms reading the run lock (57014) - is the local Compose stack up`,
    );
    await expect(refusal).rejects.not.toThrow(/cannot read/);
    expect(readSessions()).toBe(false);
    expect(stub.state.ended).toBe(stub.state.opened);
  });

  it("keeps the refusal of a taken lock when closing its client fails too: the close is its second line", async () => {
    stub.state.answer = async (text) =>
      runLockAnswer(text, {
        taken: false,
        holders: [
          { pid: 777, applicationName: "sf-session-check", backendStart: null },
        ],
      }) ?? [];
    stub.state.endError = new Error("end EPIPE");

    const refusal = postgresEntryCheck.setup();

    await expect(refusal).rejects.toThrow(
      /^another integration run holds the run lock of the test database shorts_factory_test: pid=777 .*\nclosing its client failed too: end EPIPE$/s,
    );
    await expect(refusal).rejects.toSatisfy(
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.startsWith("another integration run holds"),
    );
  });

  it.each<[string, () => Promise<void>, (text: string) => unknown[], RegExp]>([
    [
      "postgres",
      () => postgresEntryCheck.setup(),
      (text) => (text.includes("pg_stat_activity") ? [session()] : []),
      /^1 other session\(s\) on the test database shorts_factory_test: pid=4242 /,
    ],
    [
      "migrated-stack",
      () => migratedStackEntryCheck.setup(),
      (text) => (text.includes("pg_stat_activity") ? [] : [{ present: false }]),
      /^the test database is not migrated to packages\/db\/migrations /,
    ],
  ])(
    "%s keeps the refusal of a check under the lock when letting the lock go fails too: the release is its second line",
    async (_name, setup, rest, first) => {
      stub.state.answer = async (text) => {
        if (text.includes("pg_advisory_unlock")) {
          throw Object.assign(
            new Error("connect ECONNREFUSED 127.0.0.1:5442"),
            { code: "ECONNREFUSED" },
          );
        }
        return runLockAnswer(text) ?? rest(text);
      };

      const refusal = setup();

      await expect(refusal).rejects.toThrow(first);
      await expect(refusal).rejects.toThrow(
        /\nletting the run lock go failed too: cannot read the run lock of the test database on localhost:5442 \(ECONNREFUSED\)/,
      );
      // The release closed its client all the same.
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it.each<[string, () => Promise<void>, () => Promise<void>]>([
    [
      "postgres",
      () => postgresEntryCheck.setup(),
      () => postgresEntryCheck.teardown(),
    ],
    [
      "migrated-stack",
      () => migratedStackEntryCheck.setup(),
      () => migratedStackEntryCheck.teardown(),
    ],
  ])(
    "%s throws at teardown an unlock that finds no lock of its session: the run lost its barrier on the way",
    async (_name, setup, teardown) => {
      await setup();
      const before = stub.state.answer;
      stub.state.answer = async (text) =>
        text.includes("pg_advisory_unlock")
          ? [{ released: false }]
          : before(text);

      await expect(teardown()).rejects.toThrow(
        'pg_advisory_unlock found no run lock on the session that took it ({"released":false}): its connection was replaced or ended during the run',
      );
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it.each<[string, () => Promise<void>, () => Promise<void>]>([
    [
      "postgres",
      () => postgresEntryCheck.setup(),
      () => postgresEntryCheck.teardown(),
    ],
    [
      "migrated-stack",
      () => migratedStackEntryCheck.setup(),
      () => migratedStackEntryCheck.teardown(),
    ],
  ])(
    "%s throws at teardown a client that fails to close after a clean unlock, as the close of its client",
    async (_name, setup, teardown) => {
      await setup();
      stub.state.endError = Object.assign(new Error("write EPIPE"), {
        code: "EPIPE",
      });

      const refusal = teardown();

      await expect(refusal).rejects.toThrow(
        "the client of the check did not close after letting the run lock go - its session may stay open on the test database shorts_factory_test: write EPIPE",
      );
      await expect(refusal).rejects.toSatisfy(
        (error) =>
          error instanceof Error && error.cause === stub.state.endError,
      );
      expect(unlocked()).toBe(true);
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it.each<[string, () => Promise<void>]>([
    ["postgres", () => postgresEntryCheck.setup()],
    ["migrated-stack", () => migratedStackEntryCheck.setup()],
  ])(
    "%s refuses another client on the test database, and closes its own session",
    async (_name, setup) => {
      stub.state.answer = databaseWith(migrated(), [session()]);

      await expect(setup()).rejects.toThrow(
        '1 other session(s) on the test database shorts_factory_test: pid=4242 application_name="psql" client_addr=172.20.0.1/32 state=idle backend_start=2026-10-21 18:11:12+00',
      );
      expect(readSessions()).toBe(true);
      // A check that failed under the lock lets it go: no teardown follows.
      expect(unlocked()).toBe(true);
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it("migrated-stack refuses either half of the stack, before any client", async () => {
    stub.state.env.REDIS_URL = "redis://redis.example.com:6389/1";
    await expect(migratedStackEntryCheck.setup()).rejects.toThrow(
      /host "redis\.example\.com"/,
    );
    stub.state.env.REDIS_URL = LOCAL_REDIS;
    stub.state.env.DATABASE_URL =
      "postgresql://sf:sf@localhost:5432/shorts_factory_test";
    await expect(migratedStackEntryCheck.setup()).rejects.toThrow(
      /Postgres on port 5432/,
    );
    expect(stub.state.opened).toBe(0);
  });

  it("migrated-stack asks about other sessions before the migrations: a run resetting the database is named, not a missing migration", async () => {
    // The advice of "not migrated" is to run `@sf/db` - that would break the
    // run whose reset made the database look unmigrated.
    stub.state.answer = async (text) =>
      runLockAnswer(text) ??
      (text.includes("pg_stat_activity") ? [session()] : [{ present: false }]);

    await expect(migratedStackEntryCheck.setup()).rejects.toThrow(
      /1 other session\(s\) on the test database/,
    );
    expect(
      stub.state.queries.some((query) => query.includes("to_regclass")),
    ).toBe(false);
  });

  it.each<[string, () => Promise<void>]>([
    ["postgres", () => postgresEntryCheck.setup()],
    ["migrated-stack", () => migratedStackEntryCheck.setup()],
  ])(
    "%s names Compose and .env.test when the database of the run lock cannot be reached",
    async (_name, setup) => {
      stub.state.answer = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5442"), {
          code: "ECONNREFUSED",
        });
      };
      await expect(setup()).rejects.toThrow(
        /cannot read the run lock of the test database on localhost:5442 \(ECONNREFUSED\).*docker compose -f infra\/docker-compose\.yml up -d.*\.env\.test/,
      );
      expect(stub.state.ended).toBe(stub.state.opened);
    },
  );

  it("migrated-stack refuses a database the folder is not applied to", async () => {
    stub.state.answer = async (text) =>
      runLockAnswer(text) ??
      (text.includes("pg_stat_activity") ? [] : [{ present: false }]);
    await expect(migratedStackEntryCheck.setup()).rejects.toThrow(
      /not migrated to packages\/db\/migrations/,
    );
    expect(unlocked()).toBe(true);
  });

  it("migrated-stack lets a migrated stack through", async () => {
    await expect(migratedStackEntryCheck.setup()).resolves.toBeUndefined();
    // The client of assertMigrated and the one of the session check, closed;
    // the one of the run lock, held until teardown.
    expect(stub.state.opened).toBe(3);
    expect(stub.state.ended).toBe(2);
  });
});

/** A row of `pg_stat_activity` as the session check reads it: an open psql by default. */
function session(
  over: Partial<Record<keyof TestSession, unknown>> = {},
): Record<string, unknown> {
  return {
    pid: 4242,
    applicationName: "psql",
    clientAddr: "172.20.0.1/32",
    backendStart: "2026-10-21 18:11:12+00",
    backendType: "client backend",
    state: "idle",
    ...over,
  };
}

/** Answers every read of `pg_stat_activity` with `rows`, anything else with nothing. */
function sessionsAnswer(rows: (read: number) => unknown[]) {
  let reads = 0;
  return {
    reads: () => reads,
    answer: async (text: string): Promise<unknown> => {
      if (!text.includes("pg_stat_activity")) return [];
      reads += 1;
      return rows(reads);
    },
  };
}

describe("the session check of the entry checks", () => {
  it("reads through one probe client named sf-session-check, bounded on both sides, and closes it", async () => {
    await sessionCheck.assertNoOtherTestSessions();

    const { limitMs, statementTimeoutMs } = sessionCheck.SESSION_CHECK_BOUNDS;
    expect(statementTimeoutMs).toBeLessThan(limitMs);
    expect(stub.state.urls).toEqual([
      `${LOCAL_DB}?application_name=${sessionCheck.SESSION_CHECK_APPLICATION}`,
    ]);
    expect(stub.state.options).toEqual([
      {
        max: 1,
        connect_timeout: statementTimeoutMs / 1000,
        fetch_types: false,
        max_lifetime: null,
        connection: { statement_timeout: statementTimeoutMs },
      },
    ]);
    expect(stub.state.ended).toBe(1);
  });

  it("passes when a session of the first read is gone by the next: a client that was leaving", async () => {
    const db = sessionsAnswer((read) => (read === 1 ? [session()] : []));
    stub.state.answer = db.answer;

    await expect(
      sessionCheck.assertNoOtherTestSessions(),
    ).resolves.toBeUndefined();
    expect(db.reads()).toBe(2);
  });

  it("takes a pid the server gave again for another session: the same pid with another start is not lasting", async () => {
    const db = sessionsAnswer((read) =>
      read === 1
        ? [session()]
        : read === 2
          ? [session({ backendStart: "2026-10-21 18:11:13+00" })]
          : [],
    );
    stub.state.answer = db.answer;

    await expect(
      sessionCheck.assertNoOtherTestSessions(),
    ).resolves.toBeUndefined();
    expect(db.reads()).toBe(3);
  });

  it("tells onRead the counted sessions of every read", async () => {
    const db = sessionsAnswer((read) => (read === 1 ? [session()] : []));
    stub.state.answer = db.answer;
    const reads: [number, number[]][] = [];

    await sessionCheck.assertNoOtherTestSessions({
      onRead: async (read, counted) => {
        reads.push([read, counted.map(({ pid }) => pid)]);
      },
    });

    expect(reads).toEqual([
      [1, [4242]],
      [2, []],
    ]);
  });

  it("refuses a session that is there in two reads, and names its pid and how to end it", async () => {
    const db = sessionsAnswer(() => [session()]);
    stub.state.answer = db.answer;

    const refusal = sessionCheck.assertNoOtherTestSessions();

    await expect(refusal).rejects.toThrow(
      'docker compose -f infra/docker-compose.yml exec postgres psql -U sf -d shorts_factory_test -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (4242)"',
    );
    await expect(refusal).rejects.not.toThrow(/sf:sf@|postgres(?:ql)?:\/\//);
    expect(db.reads()).toBe(2);
  });

  it("refuses a database with a new client in every read of the window", async () => {
    const { samples, pauseMs } = sessionCheck.SESSION_SAMPLING;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const db = sessionsAnswer((read) => [session({ pid: 5000 + read })]);
      stub.state.answer = db.answer;

      const refusal = expect(
        sessionCheck.assertNoOtherTestSessions(),
      ).rejects.toThrow(
        `1 other session(s) on the test database shorts_factory_test: pid=${5000 + samples} `,
      );
      await vi.advanceTimersByTimeAsync(samples * pauseMs);
      await refusal;
      expect(db.reads()).toBe(samples);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "the pg_isready of a healthcheck",
      session({ applicationName: "pg_isready" }),
    ],
    [
      "the check of another run",
      session({ applicationName: "sf-session-check" }),
    ],
    ["a backend still starting", session({ applicationName: "", state: null })],
    ["autovacuum", session({ backendType: "autovacuum worker", state: null })],
    [
      "a parallel worker",
      session({ backendType: "parallel worker", state: "active" }),
    ],
  ])("does not count %s", async (_what, row) => {
    const db = sessionsAnswer(() => [row]);
    stub.state.answer = db.answer;

    await expect(
      sessionCheck.assertNoOtherTestSessions(),
    ).resolves.toBeUndefined();
  });

  it("names a database that took the connection and never answered: the limit of the probe, with Compose", async () => {
    const { limitMs } = sessionCheck.SESSION_CHECK_BOUNDS;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A paused container: the query is sent and nothing comes back.
      stub.state.answer = () => new Promise<never>(() => undefined);

      const refusal = expect(
        sessionCheck.assertNoOtherTestSessions(),
      ).rejects.toThrow(
        `the test database on localhost:5442 did not answer within ${limitMs} ms reading the sessions (PROBE_LIMIT) - is the local Compose stack up`,
      );
      await vi.advanceTimersByTimeAsync(limitMs);
      await refusal;
      // The client the limit gave up on and the fresh one after it, both ended.
      expect(stub.state.ended).toBe(stub.state.opened);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a statement the server cut at its statement_timeout as a database that did not answer, not as one it cannot reach", async () => {
    const { statementTimeoutMs } = sessionCheck.SESSION_CHECK_BOUNDS;
    stub.state.answer = async () => {
      throw Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" },
      );
    };

    const refusal = sessionCheck.assertNoOtherTestSessions();

    await expect(refusal).rejects.toThrow(
      `the test database on localhost:5442 did not answer within ${statementTimeoutMs} ms reading the sessions (57014) - is the local Compose stack up`,
    );
    await expect(refusal).rejects.not.toThrow(/cannot read/);
    expect(stub.state.ended).toBe(1);
  });

  it("throws a row of another shape as it is, not as a database it cannot reach", async () => {
    stub.state.answer = sessionsAnswer(() => [
      session({ pid: undefined }),
    ]).answer;

    const refusal = sessionCheck.assertNoOtherTestSessions();

    await expect(refusal).rejects.toThrow(
      /^pg_stat_activity gave a row the session check cannot read: \{/,
    );
    await expect(refusal).rejects.not.toThrow(/cannot read the sessions/);
    expect(stub.state.ended).toBe(1);
  });

  it.each<[string, () => unknown[], string, RegExp]>([
    [
      "the sessions it found",
      () => [session()],
      "1 other session(s)",
      /^1 other session\(s\) on the test database shorts_factory_test: pid=4242 .*\nclosing its client failed too: end EPIPE$/s,
    ],
    [
      "a row of another shape",
      () => [session({ pid: undefined })],
      "pg_stat_activity gave a row",
      /^pg_stat_activity gave a row the session check cannot read: \{.*\nclosing its client failed too: end EPIPE$/s,
    ],
  ])(
    "keeps its refusal of %s when closing its client fails too: the close is its second line, the refusal its cause",
    async (_what, rows, first, text) => {
      stub.state.answer = sessionsAnswer(rows).answer;
      stub.state.endError = new Error("end EPIPE");

      const refusal = sessionCheck.assertNoOtherTestSessions();

      await expect(refusal).rejects.toThrow(text);
      await expect(refusal).rejects.toSatisfy(
        (error) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.cause.message.startsWith(first),
      );
      expect(stub.state.ended).toBe(1);
    },
  );

  it("refuses a clean read whose client then fails to close, as the close of its client, not as a read", async () => {
    stub.state.endError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });

    const refusal = sessionCheck.assertNoOtherTestSessions();

    await expect(refusal).rejects.toThrow(
      "the client of the check did not close after reading the sessions - its session may stay open on the test database shorts_factory_test: write EPIPE",
    );
    await expect(refusal).rejects.not.toThrow(/cannot read/);
    await expect(refusal).rejects.toSatisfy(
      (error) => error instanceof Error && error.cause === stub.state.endError,
    );
    expect(stub.state.ended).toBe(1);
  });

  it("names a session it cannot date or place as such, not as null", () => {
    expect(
      sessionCheck.otherSessionsRefusal(
        sessionCheck.sessionsOf([
          session({ backendStart: null, clientAddr: null }),
        ]),
      ),
    ).toContain("client_addr=local socket state=idle backend_start=unknown");
  });

  it.each<[string, Record<string, unknown>]>([
    ["no pid", session({ pid: undefined })],
    ["a pid that is text", session({ pid: "4242" })],
    ["no application name", session({ applicationName: null })],
    ["a start that is a number", session({ backendStart: 1 })],
    ["no backend type", session({ backendType: undefined })],
  ])("refuses a row with %s, with the row", (_what, row) => {
    expect(() => sessionCheck.sessionsOf([row])).toThrow(
      /pg_stat_activity gave a row the session check cannot read: \{/,
    );
  });
});
