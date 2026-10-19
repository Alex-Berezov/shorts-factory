import { readMigrationFiles } from "drizzle-orm/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    /** How many times the setup file of the thin configs was loaded since a case reset it. */
    setupLoaded: 0,
  };
  function fakeClient(_url: string, options?: unknown): unknown {
    state.opened += 1;
    state.options.push(options);
    const query = (text: string): Promise<unknown> => {
      state.queries.push(text);
      return state.answer(text);
    };
    const sql = (strings: TemplateStringsArray) => query(strings.join("?"));
    state.last = sql;
    return Object.assign(sql, {
      end: async () => {
        state.ended += 1;
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

const { migrationsFolder } = await import("../src/migrate.js");
const MIGRATIONS = readMigrationFiles({ migrationsFolder });

/** Answers of a database that carries `rows` in its drizzle journal. */
function databaseWith(rows: { createdAt: string; hash: string }[]) {
  return async (text: string): Promise<unknown> =>
    text.includes("to_regclass") ? [{ present: true }] : rows;
}

beforeEach(() => {
  stub.state.env.DATABASE_URL = LOCAL_DB;
  stub.state.env.REDIS_URL = LOCAL_REDIS;
  stub.state.answer = databaseWith(
    MIGRATIONS.map((m) => ({
      createdAt: String(m.folderMillis),
      hash: m.hash,
    })),
  );
  stub.state.opened = 0;
  stub.state.ended = 0;
  stub.state.queries = [];
  stub.state.last = undefined;
  stub.state.options = [];
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

  it("postgres refuses a Postgres on another machine, before any client", () => {
    stub.state.env.DATABASE_URL =
      "postgresql://sf:sf@db.example.com:5442/shorts_factory_test";
    expect(() => postgresEntryCheck.setup()).toThrow(/host "db\.example\.com"/);
    expect(stub.state.opened).toBe(0);
  });

  it("postgres does not look at Redis: the db suite does not touch it", () => {
    stub.state.env.REDIS_URL = "redis://redis.example.com:6389/1";
    expect(() => postgresEntryCheck.setup()).not.toThrow();
    expect(stub.state.opened).toBe(0);
  });

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

  it("migrated-stack refuses a database the folder is not applied to", async () => {
    stub.state.answer = async () => [{ present: false }];
    await expect(migratedStackEntryCheck.setup()).rejects.toThrow(
      /not migrated to packages\/db\/migrations/,
    );
  });

  it("migrated-stack lets a migrated stack through", async () => {
    await expect(migratedStackEntryCheck.setup()).resolves.toBeUndefined();
    expect(stub.state.ended).toBe(1);
  });
});
