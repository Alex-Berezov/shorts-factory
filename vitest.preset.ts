import { type ViteUserConfig, configDefaults } from "vitest/config";

/**
 * The one test policy of the workspace. Every `vitest.config.ts` and
 * `vitest.int.config.ts` of a package is a thin call into this file, so a
 * change to where tests live, which run they belong to or how integration
 * files are scheduled is made here once instead of in twelve copies
 * (docs/adr/0011-vitest-preset-and-test-support.md).
 *
 * It lives at the root and is imported by a relative path rather than through
 * a workspace package: `@sf/core` may depend on nothing but `zod`, and a
 * preset package would be a dependency of every package, `@sf/core` included.
 * It imports nothing but `vitest/config` for the same reason: the entry checks
 * of the integration runs are named by their package specifier, and vitest
 * resolves it from the package that runs.
 */

/**
 * The directories of a package that hold its tests: `test/` next to the code,
 * or the test right next to its module in `src/`.
 */
export type TestDir = "test" | "src";

/** Where the tests of a package live unless it says otherwise. */
const TEST_DIRS: readonly TestDir[] = ["test", "src"];

/** The suffix that moves a test file out of `pnpm test` into `pnpm test:int`. */
const INT_TEST_FILES = "**/*.int.test.ts";

/** Options a package may add to its unit run. */
export interface UnitTestOptions {
  /** Modules run before every test file (`@sf/config/vitest/setup`). */
  readonly setupFiles?: readonly string[];
  /**
   * Fewer places to look for tests, never other ones: `apps/web` keeps its
   * tests in `test/` only - a `*.test.ts` under its `src/` would be a Next
   * module run in node without the setup the web tests rely on.
   */
  readonly testDirs?: readonly TestDir[];
}

/**
 * The unit run of a package (`pnpm test`): every test file but the
 * integration ones, which need the Compose stack and are asked for
 * explicitly.
 */
export function unitTestConfig(options: UnitTestOptions = {}): ViteUserConfig {
  return {
    test: {
      environment: "node",
      include: (options.testDirs ?? TEST_DIRS).map(
        (dir) => `${dir}/**/*.test.ts`,
      ),
      exclude: [...configDefaults.exclude, INT_TEST_FILES],
      ...(options.setupFiles ? { setupFiles: [...options.setupFiles] } : {}),
    },
  };
}

/**
 * What an integration run finds before its first file - a vitest
 * `globalSetup` in `packages/db/test-support/entry-check/`:
 * - `"postgres"`: the run resets and migrates the test database itself
 *   (`@sf/db`), so only the Postgres half of the stack is checked;
 * - `"migrated-stack"`: the run works on a database `@sf/db` has migrated
 *   (the api, the worker) - both URLs of the stack, then the migrations.
 */
export type EntryCheck = "postgres" | "migrated-stack";

/**
 * The `globalSetup` of an entry check: a subpath of `@sf/db`, which vitest
 * resolves from the root of the package that runs - every package with an
 * integration run depends on `@sf/db`, and `@sf/db` resolves itself.
 */
export function entryCheckModule(check: EntryCheck): string {
  return `@sf/db/test-support/entry-check/${check}`;
}

/** What a package says about its integration run. */
export interface IntTestOptions {
  /**
   * Modules run before every test file. Required, and written as a literal
   * array in the thin config of the package: `harness-selftest` reads it from
   * the file named by `--config` to check that the `test:int` gate is chosen
   * on everything the run reads.
   */
  readonly setupFiles: readonly string[];
  /** Which entry check runs before the first file; required, no default. */
  readonly entryCheck: EntryCheck;
  readonly testTimeout?: number;
  readonly hookTimeout?: number;
}

/**
 * The integration run of a package (`pnpm test:int`): the same kind of tests,
 * but they only mean anything against the Postgres and Redis of
 * `infra/docker-compose.yml`, so they are kept out of `pnpm test` and asked
 * for explicitly. A stack that is not up makes this run red - the point is to
 * notice.
 *
 * `fileParallelism: false`, always and not as an option: every integration
 * file of a package shares one test database and one Redis database with the
 * other files of that package - the db suite drops schemas, the worker suite
 * obliterates queues, the api suite pauses one - and two files at once would
 * take each other's rows and jobs. Packages are kept apart from each other by
 * `turbo run test:int --concurrency=1` in the root `package.json`.
 *
 * The entry check, always and not as an option either: the guard of the test
 * stack runs once per run, in front of every file, so no file can open
 * Postgres or Redis of another stack by forgetting a helper - a thin config
 * chooses which check, not whether.
 */
export function intTestConfig(options: IntTestOptions): ViteUserConfig {
  return {
    test: {
      environment: "node",
      include: [INT_TEST_FILES],
      setupFiles: [...options.setupFiles],
      globalSetup: [entryCheckModule(options.entryCheck)],
      fileParallelism: false,
      ...(options.testTimeout !== undefined
        ? { testTimeout: options.testTimeout }
        : {}),
      ...(options.hookTimeout !== undefined
        ? { hookTimeout: options.hookTimeout }
        : {}),
    },
  };
}
