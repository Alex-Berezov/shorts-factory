import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as publicSurface from "../src/index.js";

/**
 * The public surface of `@sf/db` is declared once, in `exports`: the package
 * root and the test support the integration suites of the apps share - the
 * stack guard and the database fixture (`test-support/`). The entry points under
 * `src/cli/` read the whole configuration and connect the moment they load, so
 * they must not be importable by name from anywhere - not from web code, not
 * from another package.
 *
 * Resolution is asked of Node itself, from a real consumer of the package
 * (`apps/worker` depends on `@sf/db`), and only resolved - `import.meta.resolve`
 * never loads the module, so a regression here reports a path instead of
 * running a migration.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumerDir = resolve(packageDir, "../../apps/worker");

/** Every specifier the cases below ask about. */
const ROOT = "@sf/db";
const SHARED_TEST_SUPPORT: readonly (readonly [string, string])[] = [
  ["@sf/db/test-support/stack-guard", "test-support/stack-guard.ts"],
  ["@sf/db/test-support/fixture", "test-support/fixture.ts"],
  ["@sf/db/test-support/relay", "test-support/relay.ts"],
  [
    "@sf/db/test-support/entry-check/postgres",
    "test-support/entry-check/postgres.ts",
  ],
  [
    "@sf/db/test-support/entry-check/migrated-stack",
    "test-support/entry-check/migrated-stack.ts",
  ],
];

/**
 * Addresses inside the package no importer may reach. Each module of `src`
 * in its `.ts` form; `exports` closes a path whatever its extension, so the
 * `.js` form and the bare one are held once each (`cli/migrate.js`,
 * `migration-lock`) rather than for every module.
 */
const DEEP_IMPORTS: readonly string[] = [
  "@sf/db/src/cli/migrate.ts",
  "@sf/db/src/cli/migrate.js",
  "@sf/db/src/cli/seed.ts",
  "@sf/db/src/migrate.ts",
  "@sf/db/src/migration-lock.ts",
  "@sf/db/src/migration-lock",
  // The guard's old address, replaced by test-support: an import left on it
  // must fail loudly rather than reach a second copy.
  "@sf/db/test/local-host-guard.js",
  "@sf/db/test-support/migration-check",
];

/**
 * The limit on the one node process the file starts. A warm start that
 * resolves every specifier takes about 80 ms on the development machine
 * (five warm runs: 76-83 ms); the limit is far above that, so
 * that only a hang, not a loaded machine, ends it.
 */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * What Node answers for each specifier from the consumer: a URL or
 * `ERR <code>`. One process for the whole file: a cold node per case was the
 * slow part of the suite, and a timeout on a loaded machine.
 */
function resolveFromConsumer(
  specifiers: readonly string[],
): Map<string, string> {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const answers = {}; for (const s of JSON.parse(process.argv[1])) { try { answers[s] = import.meta.resolve(s) } catch (e) { answers[s] = `ERR ${e.code}` } } console.log(JSON.stringify(answers))",
      JSON.stringify(specifiers),
    ],
    { cwd: consumerDir, encoding: "utf8", timeout: RESOLVE_TIMEOUT_MS },
  );
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`node answered no map of specifiers: ${output}`);
  }
  return new Map(
    Object.entries(parsed).map(([specifier, answer]) => [
      specifier,
      String(answer),
    ]),
  );
}

let answers = new Map<string, string>();

beforeAll(() => {
  answers = resolveFromConsumer([
    ROOT,
    ...SHARED_TEST_SUPPORT.map(([specifier]) => specifier),
    ...DEEP_IMPORTS,
  ]);
}, RESOLVE_TIMEOUT_MS + 1_000);

function urlOf(relativePath: string): string {
  return pathToFileURL(resolve(packageDir, relativePath)).href;
}

describe("@sf/db exports", () => {
  it("resolves the package root to the re-export module", () => {
    expect(answers.get(ROOT)).toBe(urlOf("src/index.ts"));
  });

  it.each(SHARED_TEST_SUPPORT)(
    "resolves the shared test support %s",
    (specifier, file) => {
      expect(answers.get(specifier)).toBe(urlOf(file));
    },
  );

  it.each(DEEP_IMPORTS)("refuses the deep import %s", (specifier) => {
    expect(answers.get(specifier)).toBe("ERR ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});

describe("@sf/db root module", () => {
  /**
   * The migration runner and the seed are for the entry points of
   * `src/cli/` and the test support of this package, which import them from
   * `src/`; a re-export without a consumer is a second way in that the next
   * epic would settle on by accident. The lock - its own module,
   * `src/migration-lock.ts` - and the session-level runner are for the entry
   * point next to them (`src/cli/migrate.ts`) only, and a lock taken anywhere
   * but `migrateDb` would serialise nothing. `openDb` is
   * the opening `createDb` and `createProbeDb` share: from outside it would
   * be a way to put a session parameter of a probe on a service handle. The
   * class of a busy lock and the wording of failures (`failures.ts`) are for
   * the runner and its entry points.
   */
  it.each([
    "runMigrations",
    "seedAppSettings",
    "MIGRATION_LOCK_KEY",
    "migrateDb",
    "MIGRATION_LOCK_WAIT_MS",
    "migrationLockTimeoutMessage",
    "openDb",
    "MigrationLockTimeoutError",
    "releaseStepFailure",
    "withMigrationLock",
    "stepNamer",
    "describeError",
    "throwFailures",
  ])("keeps %s inside the package", (name) => {
    const surface: Record<string, unknown> = publicSurface;

    expect(surface).not.toHaveProperty(name);
  });
});

describe("@sf/db budget read of the api", () => {
  /**
   * The read of every cap for `/system/status` is a function of the root,
   * not a method of the guard a job is handed: the api calls it directly.
   */
  it("exports countBudgetChecks from the root", () => {
    const surface: Record<string, unknown> = publicSurface;

    expect(typeof surface.countBudgetChecks).toBe("function");
  });
});

describe("@sf/db probe handle", () => {
  /**
   * The bounded handle of a probe is for the api, outside the package: it has
   * to be reachable from the root (docs/TECH_DEBT.md § E0-12H, п.5).
   */
  it.each(["createProbeDb", "ProbeLimitError", "ProbeClosedError"])(
    "exports %s from the root",
    (name) => {
      const surface: Record<string, unknown> = publicSurface;

      expect(typeof surface[name]).toBe("function");
    },
  );
});
