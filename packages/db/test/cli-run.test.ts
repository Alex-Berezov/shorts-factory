import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliError,
  type CliOutput,
  SEED_BEFORE_MIGRATE,
  runEntry,
  runMigrateCli,
  runSeedCli,
} from "../src/cli/run.js";

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
   * The migrations are in; only the unlock after them failed. The lock ends
   * with the session the entry point closes next, so the run is a success
   * with a line on stderr - not an exit code 1 over applied migrations.
   */
  it("succeeds when only releasing the lock failed, and says so on stderr", async () => {
    const output = recordingOutput();
    const close = vi.fn(async () => undefined);

    await runMigrateCli(
      {
        migrate: async (onReleaseError) => {
          onReleaseError(new Error("write CONNECTION_ENDED"));
          return { applied: 1, total: 1 };
        },
        close,
      },
      output,
    );

    expect(output.lines).toEqual(["migrations: applied 1, 1 in total"]);
    expect(output.errors).toEqual([
      "releasing the migration lock failed: write CONNECTION_ENDED",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

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

  it("fails with the close error when only closing failed", async () => {
    const output = recordingOutput();
    const closeError = new Error("write CONNECTION_ENDED");

    await expect(
      runMigrateCli(
        {
          migrate: async () => ({ applied: 1, total: 1 }),
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

  /** What the entry point wrote to the real process streams. */
  function captureProcessOutput(): { out: string[]; err: string[] } {
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
    return { out, err };
  }

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

  it("db:migrate opens one connection and reports a failed unlock on stderr", async () => {
    const { createDb, closeDb } = mockConnection();
    const releaseError = new Error("unlock lost");
    const migrateDb = vi.fn(
      async (
        _db: unknown,
        options?: { onReleaseError?: (error: unknown) => void },
      ) => {
        options?.onReleaseError?.(releaseError);
        return { applied: 0, total: 1 };
      },
    );
    vi.doMock("../src/migrate.js", () => ({ migrateDb }));
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

/**
 * The Compose `migrate` service runs the image's command: both entry points,
 * the seed only after the migrations succeeded - the worker refuses to start
 * without the queue switches the seed writes.
 */
describe("the migrate image", () => {
  const dockerfile = new URL(
    "../../../infra/docker/migrate.Dockerfile",
    import.meta.url,
  );

  it("runs the migrations, then the seed", () => {
    const commands = readFileSync(dockerfile, "utf8")
      .split(/\r?\n/)
      .filter((line) => /^CMD\s/i.test(line));

    expect(commands).toHaveLength(1);
    const steps = (commands[0] ?? "")
      .replace(/^CMD\s+/i, "")
      .split("&&")
      .map((step) => step.trim());
    expect(steps).toEqual([
      "node --import tsx src/cli/migrate.ts",
      "node --import tsx src/cli/seed.ts",
    ]);
    // The image's working directory is this package (WORKDIR /repo/packages/db).
    for (const script of ["src/cli/migrate.ts", "src/cli/seed.ts"]) {
      expect(existsSync(new URL(`../${script}`, import.meta.url))).toBe(true);
    }
  });
});
