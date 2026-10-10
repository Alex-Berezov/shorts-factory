import { withCleanup } from "../cleanup.js";
import type { MigrationOutcome } from "../migrate.js";

/**
 * What `pnpm db:migrate` and `pnpm db:seed` (and the Compose `migrate`
 * service, which runs both) actually do, without the process around them.
 *
 * Kept apart from `migrate.ts` and `seed.ts` so the answers that matter to an
 * operator - "what did it do", "what to run first", "which failure was the
 * real one" - can be tested without a database and without importing a module
 * that reads the configuration and connects the moment it is loaded.
 */

/** Where the entry points write: one line per outcome, no logger setup. */
export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

/** The output of a real run: stdout for the result, stderr for failures. */
export const processOutput: CliOutput = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/**
 * A failure the operator can act on from its message alone; the entry point
 * prints the message instead of a stack trace.
 */
export class CliError extends Error {
  override name = "CliError";
}

/** Printed when `db:seed` runs on a database `db:migrate` never touched. */
export const SEED_BEFORE_MIGRATE =
  'table "app_setting" does not exist - run db:migrate first';

/**
 * Runs `body`, then `close`, with the policy of `withCleanup`: when the body
 * fails, its error is thrown and a failure to close is written to stderr; when
 * only the close fails, that is the failure.
 */
function closeAfter<T>(
  body: () => Promise<T>,
  close: () => Promise<void>,
  output: CliOutput,
): Promise<T> {
  return withCleanup(body, close, (closeError) => {
    output.err(
      `closing the database connection also failed: ${describeError(closeError)}`,
    );
  });
}

export interface MigrateCliSteps {
  /**
   * Applies the migrations; a failure of releasing the lock afterwards goes
   * to `onReleaseError` instead of failing the run (`migrateDb`).
   */
  migrate(onReleaseError: (error: unknown) => void): Promise<MigrationOutcome>;
  close(): Promise<void>;
}

/**
 * `db:migrate`: applies pending migrations and says how many it applied. A
 * lock that could not be released is written to stderr; the run still
 * succeeds, because the migrations are applied and closing the connection
 * ends the lock with the session.
 */
export async function runMigrateCli(
  steps: MigrateCliSteps,
  output: CliOutput,
): Promise<void> {
  const outcome = await closeAfter(
    () =>
      steps.migrate((releaseError) => {
        output.err(
          `releasing the migration lock failed: ${describeError(releaseError)}`,
        );
      }),
    steps.close,
    output,
  );
  output.out(
    outcome.applied === 0
      ? `migrations: nothing to apply, ${outcome.total} already applied`
      : `migrations: applied ${outcome.applied}, ${outcome.total} in total`,
  );
}

export interface SeedCliSteps {
  /** Whether the table the seed writes to exists at all. */
  hasSettingsTable(): Promise<boolean>;
  seed(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `db:seed`: writes the default settings. On a database without the schema it
 * stops with a hint instead of the driver's `relation does not exist`.
 */
export async function runSeedCli(
  steps: SeedCliSteps,
  output: CliOutput,
): Promise<void> {
  await closeAfter(
    async () => {
      if (!(await steps.hasSettingsTable())) {
        throw new CliError(SEED_BEFORE_MIGRATE);
      }
      await steps.seed();
    },
    steps.close,
    output,
  );
  output.out("app settings seeded");
}

/**
 * Runs an entry point and answers with its exit code. A `CliError` is printed
 * as its message; anything else keeps its stack, because nobody has written a
 * better explanation for it yet.
 */
export async function runEntry(
  main: () => Promise<void>,
  output: CliOutput,
): Promise<number> {
  try {
    await main();
    return 0;
  } catch (error) {
    output.err(
      error instanceof CliError
        ? error.message
        : describeError(error, { stack: true }),
    );
    return 1;
  }
}

function describeError(error: unknown, opts?: { stack: boolean }): string {
  if (error instanceof Error) {
    return (opts?.stack === true ? error.stack : undefined) ?? error.message;
  }
  return String(error);
}
