import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliError,
  type CliOutput,
  SEED_BEFORE_MIGRATE,
  runEntry,
  runMigrateCli,
  runSeedCli,
  runSetupCli,
} from "../src/cli/run.js";
import {
  MigrationLockTimeoutError,
  type ReleaseStep,
  migrationLockTimeoutMessage,
} from "../src/migrate.js";
import { captureProcessOutput } from "./capture-output.js";

/**
 * The operator-facing half of `pnpm db:migrate` / `pnpm db:seed`: what they
 * print, what they tell an operator who runs them in the wrong order, and
 * which failure reaches the exit code when two things break at once.
 */

function recordingOutput(): CliOutput & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => {
      lines.push(line);
    },
    err: (line) => {
      errors.push(line);
    },
  };
}

/**
 * One log of what reached stdout, stderr and the close, in order: whether the
 * outcome was written before the connection was closed.
 */
function eventLog(): {
  events: string[];
  output: CliOutput;
  close: () => Promise<void>;
  failingClose: (error: Error) => () => Promise<void>;
} {
  const events: string[] = [];
  return {
    events,
    output: {
      out: (line) => {
        events.push(`out: ${line}`);
      },
      err: (line) => {
        events.push(`err: ${line}`);
      },
    },
    close: async () => {
      events.push("close");
    },
    failingClose: (error) => async () => {
      events.push("close");
      throw error;
    },
  };
}

/**
 * What a close that failed after a successful run says, by what the run did.
 * Literals: a text built by the code under test would follow a broken text.
 */
const CLOSE_FAILED_AFTER = {
  noneToApply:
    "closing the database connection failed after the run found no migrations to apply: write CONNECTION_ENDED",
  oneApplied:
    "closing the database connection failed after the run applied 1 migration: write CONNECTION_ENDED",
  twoApplied:
    "closing the database connection failed after the run applied 2 migrations: write CONNECTION_ENDED",
  oneAppliedAndSeeded:
    "closing the database connection failed after the run applied 1 migration and seeded the settings: write CONNECTION_ENDED",
  noneToApplyAndSeeded:
    "closing the database connection failed after the run found no migrations to apply and seeded the settings: write CONNECTION_ENDED",
} as const;

describe("runMigrateCli", () => {
  it("prints one line with the number of migrations it applied", async () => {
    const output = recordingOutput();
    const close = vi.fn(async () => undefined);

    await runMigrateCli(
      { migrate: async () => ({ applied: 2, total: 3 }), close },
      output,
    );

    expect(output.lines).toEqual(["migrations: applied 2, 3 in total"]);
    expect(output.errors).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("says so when there was nothing to apply", async () => {
    const output = recordingOutput();

    await runMigrateCli(
      {
        migrate: async () => ({ applied: 0, total: 3 }),
        close: async () => undefined,
      },
      output,
    );

    expect(output.lines).toEqual([
      "migrations: nothing to apply, 3 already applied",
    ]);
  });

  /**
   * The migrations are in; only a step of putting the session back after them
   * failed. The lock ends with the session the entry point closes next, so
   * the run is a success with a line on stderr naming the step - not an exit
   * code 1 over applied migrations. The expected lines are literals: a text
   * built by `releaseStepFailure` would follow a broken text.
   */
  it.each([
    ["unlock", "releasing the migration lock failed: write CONNECTION_ENDED"],
    [
      "client_min_messages",
      "restoring client_min_messages failed: write CONNECTION_ENDED",
    ],
    [
      "timeouts",
      "restoring lock_timeout and statement_timeout failed: write CONNECTION_ENDED",
    ],
  ] as const)(
    "succeeds when only the step %s failed, and names it on stderr",
    async (step: ReleaseStep, line: string) => {
      const output = recordingOutput();
      const close = vi.fn(async () => undefined);

      await runMigrateCli(
        {
          migrate: async (onReleaseError) => {
            onReleaseError(step, new Error("write CONNECTION_ENDED"));
            return { applied: 1, total: 1 };
          },
          close,
        },
        output,
      );

      expect(output.lines).toEqual(["migrations: applied 1, 1 in total"]);
      expect(output.errors).toEqual([line]);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("throws the migration failure, not the failure of closing after it", async () => {
    const output = recordingOutput();
    const cause = new Error('type "content_format" already exists');

    await expect(
      runMigrateCli(
        {
          migrate: async () => {
            throw cause;
          },
          close: async () => {
            throw new Error("write CONNECTION_ENDED");
          },
        },
        output,
      ),
    ).rejects.toBe(cause);

    expect(output.lines).toEqual([]);
    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]).toContain("CONNECTION_ENDED");
  });

  /**
   * The migrations are applied, then closing fails: the outcome is already on
   * stdout - written before the close - and the failure is one line, exit 1.
   */
  it("prints the outcome before closing, and fails in one line when only closing failed", async () => {
    const log = eventLog();
    const closeError = new Error("write CONNECTION_ENDED");

    const run = runMigrateCli(
      {
        migrate: async () => ({ applied: 1, total: 1 }),
        close: log.failingClose(closeError),
      },
      log.output,
    );

    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toMatchObject({
      message: CLOSE_FAILED_AFTER.oneApplied,
      cause: closeError,
    });
    expect(log.events).toEqual([
      "out: migrations: applied 1, 1 in total",
      "close",
    ]);
  });

  /**
   * The line of a failed close says what the run had done: "applied" over a
   * run that applied nothing would send the operator after migrations that
   * do not exist.
   */
  it.each([
    [0, CLOSE_FAILED_AFTER.noneToApply],
    [2, CLOSE_FAILED_AFTER.twoApplied],
  ] as const)(
    "says what a run that applied %s migrations did when only closing failed",
    async (applied: number, message: string) => {
      const closeError = new Error("write CONNECTION_ENDED");

      await expect(
        runMigrateCli(
          {
            migrate: async () => ({ applied, total: 2 }),
            close: async () => {
              throw closeError;
            },
          },
          recordingOutput(),
        ),
      ).rejects.toMatchObject({ message, cause: closeError });
    },
  );
});

/**
 * The exit code of `db:migrate` when a step of putting the session back
 * failed (decision R1 of E0-12I): applied migrations and a closed connection are a
 * success with the step on stderr; a close that failed as well is exit 1.
 */
describe("runMigrateCli exit code", () => {
  it("answers 0 when a step of putting the session back failed and the close did not", async () => {
    const output = recordingOutput();

    const code = await runEntry(
      () =>
        runMigrateCli(
          {
            migrate: async (onReleaseError) => {
              onReleaseError("timeouts", new Error("socket hang up"));
              return { applied: 0, total: 1 };
            },
            close: async () => undefined,
          },
          output,
        ),
      output,
    );

    expect(code).toBe(0);
    expect(output.errors).toEqual([
      "restoring lock_timeout and statement_timeout failed: socket hang up",
    ]);
    expect(output.lines).toEqual([
      "migrations: nothing to apply, 1 already applied",
    ]);
  });

  it("answers 1 when a step of putting the session back failed and so did the close", async () => {
    const output = recordingOutput();

    const code = await runEntry(
      () =>
        runMigrateCli(
          {
            migrate: async (onReleaseError) => {
              onReleaseError("unlock", new Error("socket hang up"));
              return { applied: 0, total: 1 };
            },
            close: async () => {
              throw new Error("write CONNECTION_ENDED");
            },
          },
          output,
        ),
      output,
    );

    expect(code).toBe(1);
    expect(output.errors).toEqual([
      "releasing the migration lock failed: socket hang up",
      CLOSE_FAILED_AFTER.noneToApply,
    ]);
    expect(output.lines).toEqual([
      "migrations: nothing to apply, 1 already applied",
    ]);
  });
});

describe("runSetupCli", () => {
  it("migrates, seeds, prints both outcomes in order and closes once", async () => {
    const log = eventLog();
    const seed = vi.fn(async () => undefined);
    const close = vi.fn(log.close);

    await runSetupCli(
      {
        migrate: async () => ({ applied: 1, total: 1 }),
        seed,
        close,
      },
      log.output,
    );

    expect(log.events).toEqual([
      "out: migrations: applied 1, 1 in total",
      "out: app settings seeded",
      "close",
    ]);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not seed after a failed migration and throws the migration failure", async () => {
    const output = recordingOutput();
    const cause = new Error('type "content_format" already exists');
    const seed = vi.fn(async () => undefined);
    const close = vi.fn(async () => {
      throw new Error("write CONNECTION_ENDED");
    });

    await expect(
      runSetupCli(
        {
          migrate: async () => {
            throw cause;
          },
          seed,
          close,
        },
        output,
      ),
    ).rejects.toBe(cause);

    expect(seed).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.lines).toEqual([]);
    expect(output.errors).toEqual([
      "closing the database connection also failed: write CONNECTION_ENDED",
    ]);
  });

  it("seeds after a failed step of putting the session back", async () => {
    const output = recordingOutput();
    const seed = vi.fn(async () => undefined);

    await runSetupCli(
      {
        migrate: async (onReleaseError) => {
          onReleaseError("client_min_messages", new Error("socket hang up"));
          return { applied: 0, total: 1 };
        },
        seed,
        close: async () => undefined,
      },
      output,
    );

    expect(seed).toHaveBeenCalledTimes(1);
    expect(output.errors).toEqual([
      "restoring client_min_messages failed: socket hang up",
    ]);
    expect(output.lines).toEqual([
      "migrations: nothing to apply, 1 already applied",
      "app settings seeded",
    ]);
  });

  /**
   * The migrations that create the table have just run: the seed does not
   * ask for it, and a failure of the seed - the table still missing because
   * the journal and the schema disagree - is thrown as the driver said it,
   * not as "run db:migrate first", which the operator has just done.
   */
  it("throws a failure of the seed as it is, without sending the operator to db:migrate", async () => {
    const output = recordingOutput();
    const cause = new Error('relation "app_setting" does not exist');
    const seed = vi.fn(async () => {
      throw cause;
    });
    const close = vi.fn(async () => undefined);

    const run = runSetupCli(
      {
        migrate: async () => ({ applied: 0, total: 1 }),
        seed,
        close,
      },
      output,
    );

    await expect(run).rejects.toBe(cause);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.lines).toEqual([
      "migrations: nothing to apply, 1 already applied",
    ]);
    expect(output.errors).toEqual([]);
  });

  it("prints both outcomes and fails in one line when only closing failed", async () => {
    const log = eventLog();
    const closeError = new Error("write CONNECTION_ENDED");

    const run = runSetupCli(
      {
        migrate: async () => ({ applied: 1, total: 1 }),
        seed: async () => undefined,
        close: log.failingClose(closeError),
      },
      log.output,
    );

    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toMatchObject({
      message: CLOSE_FAILED_AFTER.oneAppliedAndSeeded,
      cause: closeError,
    });
    expect(log.events).toEqual([
      "out: migrations: applied 1, 1 in total",
      "out: app settings seeded",
      "close",
    ]);
  });

  it("says the seed ran too when a run with nothing to apply failed only to close", async () => {
    const closeError = new Error("write CONNECTION_ENDED");

    await expect(
      runSetupCli(
        {
          migrate: async () => ({ applied: 0, total: 1 }),
          seed: async () => undefined,
          close: async () => {
            throw closeError;
          },
        },
        recordingOutput(),
      ),
    ).rejects.toMatchObject({
      message: CLOSE_FAILED_AFTER.noneToApplyAndSeeded,
      cause: closeError,
    });
  });

  /**
   * The seed failed and so did the close after it: the seed's failure is the
   * one thrown, the close's goes to stderr - and the seed is not reported
   * done.
   */
  it("throws the seed failure, not the failure of closing after it", async () => {
    const output = recordingOutput();
    const cause = new Error("violates check constraint");
    const close = vi.fn(async () => {
      throw new Error("write CONNECTION_ENDED");
    });

    await expect(
      runSetupCli(
        {
          migrate: async () => ({ applied: 1, total: 1 }),
          seed: async () => {
            throw cause;
          },
          close,
        },
        output,
      ),
    ).rejects.toBe(cause);

    expect(close).toHaveBeenCalledTimes(1);
    expect(output.lines).toEqual(["migrations: applied 1, 1 in total"]);
    expect(output.errors).toEqual([
      "closing the database connection also failed: write CONNECTION_ENDED",
    ]);
  });
});

describe("runSeedCli", () => {
  it("prints one line after seeding", async () => {
    const output = recordingOutput();
    const seed = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    await runSeedCli(
      { hasSettingsTable: async () => true, seed, close },
      output,
    );

    expect(output.lines).toEqual(["app settings seeded"]);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("asks for db:migrate instead of writing into a missing table", async () => {
    const output = recordingOutput();
    const seed = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    const run = runSeedCli(
      { hasSettingsTable: async () => false, seed, close },
      output,
    );

    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow("run db:migrate first");
    expect(seed).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.lines).toEqual([]);
  });

  it("throws the seed failure, not the failure of closing after it", async () => {
    const output = recordingOutput();
    const cause = new Error("violates check constraint");

    await expect(
      runSeedCli(
        {
          hasSettingsTable: async () => true,
          seed: async () => {
            throw cause;
          },
          close: async () => {
            throw new Error("write CONNECTION_ENDED");
          },
        },
        output,
      ),
    ).rejects.toBe(cause);

    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]).toContain("CONNECTION_ENDED");
  });

  it("fails with the close error when only closing failed", async () => {
    const output = recordingOutput();
    const closeError = new Error("write CONNECTION_ENDED");

    await expect(
      runSeedCli(
        {
          hasSettingsTable: async () => true,
          seed: async () => undefined,
          close: async () => {
            throw closeError;
          },
        },
        output,
      ),
    ).rejects.toBe(closeError);
    expect(output.lines).toEqual([]);
  });
});

describe("runEntry", () => {
  it("answers 0 when the entry point succeeds", async () => {
    const output = recordingOutput();

    await expect(runEntry(async () => undefined, output)).resolves.toBe(0);
    expect(output.errors).toEqual([]);
  });

  it("prints a CliError as its message alone and answers 1", async () => {
    const output = recordingOutput();

    const code = await runEntry(async () => {
      throw new CliError(SEED_BEFORE_MIGRATE);
    }, output);

    expect(code).toBe(1);
    expect(output.errors).toEqual([SEED_BEFORE_MIGRATE]);
  });

  /** A busy lock is something the operator acts on from the message alone. */
  it("prints a MigrationLockTimeoutError as its message alone and answers 1", async () => {
    const output = recordingOutput();

    const code = await runEntry(async () => {
      throw new MigrationLockTimeoutError(300, {
        cause: Object.assign(new Error("canceling statement"), {
          code: "55P03",
        }),
      });
    }, output);

    expect(code).toBe(1);
    expect(output.errors).toEqual([migrationLockTimeoutMessage(300)]);
    expect(output.errors[0]).not.toContain("\n    at ");
  });

  it("keeps the stack of any other failure and answers 1", async () => {
    const output = recordingOutput();

    const code = await runEntry(async () => {
      throw new Error("boom");
    }, output);

    expect(code).toBe(1);
    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]).toMatch(/^Error: boom\n\s+at /);
  });
});

/**
 * The entry points themselves - `src/cli/migrate.ts` and `src/cli/seed.ts` run
 * on import - with the library and the configuration replaced: what they hand
 * to `createDb`, `migrateDb` and the seed, and what reaches stdout, stderr and
 * the exit code.
 */
describe("entry points", () => {
  const DATABASE_URL = "postgres://sf:sf@127.0.0.1:5442/entry_point_test";
  const handle = { name: "the handle createDb opened" };

  function mockConnection() {
    const createDb = vi.fn(() => handle);
    const closeDb = vi.fn(async () => undefined);
    vi.doMock("@sf/config", () => ({ env: { DATABASE_URL } }));
    vi.doMock("../src/client.js", () => ({ createDb, closeDb }));
    return { createDb, closeDb };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@sf/config");
    vi.doUnmock("../src/client.js");
    vi.doUnmock("../src/migrate.js");
    vi.doUnmock("../src/seed.js");
    vi.resetModules();
    process.exitCode = undefined;
  });

  type MigrateDbStub = (
    db: unknown,
    options?: {
      onReleaseError?: (step: ReleaseStep, error: unknown) => void;
    },
  ) => Promise<{ applied: number; total: number }>;

  /**
   * Replaces `migrateDb` only: what `run.ts` takes from the same module - the
   * class of a busy lock and the texts of the steps - stays the real one.
   */
  function mockMigrateDb(migrateDb: MigrateDbStub): void {
    vi.doMock("../src/migrate.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/migrate.js")>()),
      migrateDb,
    }));
  }

  function mockSeed(tableExists: boolean) {
    const hasAppSettingTable = vi.fn(async () => tableExists);
    const seedAppSettings = vi.fn(async () => undefined);
    vi.doMock("../src/seed.js", () => ({
      hasAppSettingTable,
      seedAppSettings,
    }));
    return { hasAppSettingTable, seedAppSettings };
  }

  it("db:migrate opens one connection and reports a failed unlock on stderr", async () => {
    const { createDb, closeDb } = mockConnection();
    const releaseError = new Error("unlock lost");
    const migrateDb = vi.fn<MigrateDbStub>(async (_db, options) => {
      options?.onReleaseError?.("unlock", releaseError);
      return { applied: 0, total: 1 };
    });
    mockMigrateDb(migrateDb);
    vi.resetModules();
    const output = captureProcessOutput();

    await import("../src/cli/migrate.js");

    // One connection: the advisory lock of migrateDb belongs to a session.
    expect(createDb).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith(DATABASE_URL, { max: 1 });
    expect(migrateDb).toHaveBeenCalledTimes(1);
    expect(migrateDb).toHaveBeenCalledWith(handle, {
      onReleaseError: expect.any(Function),
    });
    expect(output.err).toEqual([
      "releasing the migration lock failed: unlock lost\n",
    ]);
    expect(output.out).toEqual([
      "migrations: nothing to apply, 1 already applied\n",
    ]);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledWith(handle);
    expect(process.exitCode).toBe(0);
  });

  /**
   * The table check of `db:seed` answers "missing" here, and is not asked:
   * after the migrations it would only send the operator to run them again.
   * A failed step of putting the session back reaches stderr by name and does
   * not stop the seed.
   */
  it("migrate-and-seed migrates and seeds through one handle and closes it once", async () => {
    const { createDb, closeDb } = mockConnection();
    const releaseError = new Error("unlock lost");
    const migrateDb = vi.fn<MigrateDbStub>(async (_db, options) => {
      options?.onReleaseError?.("unlock", releaseError);
      return { applied: 1, total: 1 };
    });
    mockMigrateDb(migrateDb);
    const { hasAppSettingTable, seedAppSettings } = mockSeed(false);
    vi.resetModules();
    const output = captureProcessOutput();

    await import("../src/cli/migrate-and-seed.js");

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith(DATABASE_URL, { max: 1 });
    expect(migrateDb).toHaveBeenCalledTimes(1);
    expect(migrateDb).toHaveBeenCalledWith(handle, {
      onReleaseError: expect.any(Function),
    });
    expect(hasAppSettingTable).toHaveBeenCalledTimes(0);
    expect(seedAppSettings).toHaveBeenCalledTimes(1);
    expect(seedAppSettings).toHaveBeenCalledWith(handle);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledWith(handle);
    expect(output.out).toEqual([
      "migrations: applied 1, 1 in total\n",
      "app settings seeded\n",
    ]);
    expect(output.err).toEqual([
      "releasing the migration lock failed: unlock lost\n",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("migrate-and-seed does not seed after a failed migration and exits with 1", async () => {
    const { closeDb } = mockConnection();
    const migrateDb = vi.fn<MigrateDbStub>(async () => {
      throw new Error('type "content_format" already exists');
    });
    mockMigrateDb(migrateDb);
    const { hasAppSettingTable, seedAppSettings } = mockSeed(true);
    vi.resetModules();
    const output = captureProcessOutput();

    await import("../src/cli/migrate-and-seed.js");

    expect(migrateDb).toHaveBeenCalledTimes(1);
    expect(hasAppSettingTable).toHaveBeenCalledTimes(0);
    expect(seedAppSettings).toHaveBeenCalledTimes(0);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(output.out).toEqual([]);
    expect(output.err).toHaveLength(1);
    expect(output.err[0]).toContain('type "content_format" already exists');
    expect(process.exitCode).toBe(1);
  });

  it("db:seed asks whether the table exists before it seeds", async () => {
    const { createDb } = mockConnection();
    const hasAppSettingTable = vi.fn(async () => false);
    const seedAppSettings = vi.fn(async () => undefined);
    vi.doMock("../src/seed.js", () => ({
      hasAppSettingTable,
      seedAppSettings,
    }));
    vi.resetModules();
    const output = captureProcessOutput();

    await import("../src/cli/seed.js");

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith(DATABASE_URL, { max: 1 });
    expect(hasAppSettingTable).toHaveBeenCalledTimes(1);
    expect(hasAppSettingTable).toHaveBeenCalledWith(handle);
    expect(seedAppSettings).not.toHaveBeenCalled();
    expect(output.err).toEqual([`${SEED_BEFORE_MIGRATE}\n`]);
    expect(process.exitCode).toBe(1);
  });

  it("db:seed seeds through the handle once the table is there", async () => {
    const { createDb, closeDb } = mockConnection();
    const hasAppSettingTable = vi.fn(async () => true);
    const seedAppSettings = vi.fn(async () => undefined);
    vi.doMock("../src/seed.js", () => ({
      hasAppSettingTable,
      seedAppSettings,
    }));
    vi.resetModules();
    const output = captureProcessOutput();

    await import("../src/cli/seed.js");

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(hasAppSettingTable).toHaveBeenCalledTimes(1);
    expect(seedAppSettings).toHaveBeenCalledTimes(1);
    expect(seedAppSettings).toHaveBeenCalledWith(handle);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledWith(handle);
    expect(output.out).toEqual(["app settings seeded\n"]);
    expect(process.exitCode).toBe(0);
  });
});
