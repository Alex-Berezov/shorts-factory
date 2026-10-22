import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type MigrateStatement, runMigrations } from "../src/migrate.js";
import { heldAdvisoryLocks } from "../test-support/advisory-locks.js";
import {
  emptyTestDatabase,
  openTestSql,
  resetTestDatabase,
  testDatabaseUrl,
} from "../test-support/fixture.js";
import { failStep } from "./migrate-steps.js";

/**
 * What `runMigrations` - the runner of the test suites, with a connection of
 * its own - throws when the steps that put the session back or the close of
 * that connection fail: no failure is dropped (DoD of E0-12I). The handle it
 * opens is the real one; a case makes one of its steps fail by name and,
 * when it asks to, the close fail after the connection is really closed.
 */
const faults = vi.hoisted(() => ({
  steps: [] as { name: MigrateStatement; error: unknown }[],
  close: undefined as { error: unknown } | undefined,
  hits: [] as { readonly hits: number }[],
  /** Advisory locks held on the test database as each close began. */
  locksAtClose: [] as number[],
}));

vi.mock("../src/client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/client.js")>();
  return {
    ...real,
    createDb: (...args: Parameters<typeof real.createDb>) => {
      const db = real.createDb(...args);
      for (const { name, error } of faults.steps) {
        faults.hits.push(failStep(db, name, error));
      }
      return db;
    },
    closeDb: async (...args: Parameters<typeof real.closeDb>) => {
      // Read before the close: closing ends the session, and any lock with
      // it, so a read after it would say 0 whatever the unlock did.
      faults.locksAtClose.push(await heldAdvisoryLocks(sql));
      await real.closeDb(...args);
      if (faults.close !== undefined) throw faults.close.error;
    },
  };
});

const TEST_DATABASE_URL = testDatabaseUrl().href;

/** The file's own connection for reads about the database itself. */
const sql = openTestSql();

/** What `runMigrations` threw, or `"resolved"`. */
async function outcomeOf(run: Promise<void>): Promise<unknown> {
  return run.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

beforeAll(async () => {
  await resetTestDatabase();
  // The reset goes through the mocked close too.
  faults.locksAtClose = [];
});

afterAll(async () => {
  await sql.end();
});

afterEach(() => {
  faults.steps = [];
  faults.close = undefined;
  faults.hits = [];
  faults.locksAtClose = [];
});

describe("runMigrations when putting the session back or closing fails", () => {
  /**
   * The migrations are in, one step of putting the session back failed: the
   * run fails with the step's name and the driver's error as the cause - not
   * a quiet success. The messages are literals: a text built by the code
   * under test would follow a broken text. The lock is still held as the
   * close begins only when the unlock itself failed.
   */
  it.each([
    ["unlock", "releasing the migration lock failed: step failed", 1],
    [
      "client_min_messages",
      "restoring client_min_messages failed: step failed",
      0,
    ],
    [
      "timeouts",
      "restoring lock_timeout and statement_timeout failed: step failed",
      0,
    ],
  ] as const)(
    "throws a failed step %s by its name, with the driver's error as the cause",
    async (name, message, locksAtClose) => {
      const stepError = Object.assign(new Error("step failed"), {
        code: "08006",
      });
      faults.steps = [{ name, error: stepError }];

      const thrown = await outcomeOf(runMigrations(TEST_DATABASE_URL));

      expect(faults.hits.map((fault) => fault.hits)).toEqual([1]);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(AggregateError);
      expect(thrown).toMatchObject({ message, cause: stepError });
      expect(faults.locksAtClose).toEqual([locksAtClose]);
      await vi.waitFor(async () => {
        expect(await heldAdvisoryLocks(sql)).toBe(0);
      });
    },
  );

  /**
   * `resetTestDatabase` migrates through `runMigrations`, which reports no
   * outcome and so does not count the journal (DoD of E0-12I): the step
   * never comes. A count would come once the journal exists, and fail here.
   */
  it("migrates without counting the journal, through resetTestDatabase", async () => {
    faults.steps = [{ name: "count_journal", error: new Error("counted") }];

    await expect(resetTestDatabase()).resolves.toBeUndefined();

    expect(faults.hits.map((fault) => fault.hits)).toEqual([0]);
  });

  it("throws a failed close as it is", async () => {
    const closeError = new Error("write CONNECTION_ENDED");
    faults.close = { error: closeError };

    await expect(runMigrations(TEST_DATABASE_URL)).rejects.toBe(closeError);
  });

  /** A close that throws `undefined` has failed all the same. */
  it("rejects with undefined when the close threw undefined", async () => {
    faults.close = { error: undefined };

    const thrown = await outcomeOf(runMigrations(TEST_DATABASE_URL));

    expect(thrown).not.toBe("resolved");
    expect(thrown).toBeUndefined();
  });

  /**
   * Everything fails: the migration, two steps of putting the session back,
   * the close. All four come out, in that order, and the message names each
   * with its code - the line a stack trace at the edge of the process shows.
   */
  it("throws every failure together, in order, each named with its code", async () => {
    await emptyTestDatabase();
    // The first statement of 0000_core, already there: the migration fails.
    await sql`CREATE TYPE public.snapshot_point AS ENUM ('1h')`;
    const unlockError = Object.assign(new Error("unlock failed"), {
      code: "08006",
    });
    const restoreError = new Error("restore failed");
    const closeError = Object.assign(new Error("write CONNECTION_ENDED"), {
      code: "CONNECTION_ENDED",
    });
    faults.steps = [
      { name: "unlock", error: unlockError },
      { name: "client_min_messages", error: restoreError },
    ];
    faults.close = { error: closeError };

    try {
      const thrown = await outcomeOf(runMigrations(TEST_DATABASE_URL));

      expect(thrown).toBeInstanceOf(AggregateError);
      const errors = thrown instanceof AggregateError ? thrown.errors : [];
      expect(errors).toHaveLength(4);
      expect(errors[0]).toMatchObject({ code: "42710" });
      expect(errors[1]).toMatchObject({
        message: "releasing the migration lock failed: unlock failed",
        cause: unlockError,
      });
      expect(errors[2]).toMatchObject({
        message: "restoring client_min_messages failed: restore failed",
        cause: restoreError,
      });
      expect(errors[3]).toBe(closeError);
      expect(thrown).toMatchObject({
        message: expect.stringMatching(
          /^4 failures: .+ \[42710\]; releasing the migration lock failed: unlock failed \[08006\]; restoring client_min_messages failed: restore failed; write CONNECTION_ENDED \[CONNECTION_ENDED\]$/,
        ),
      });
    } finally {
      faults.steps = [];
      faults.close = undefined;
      await resetTestDatabase();
    }
  });
});
