import { withCleanup } from "../cleanup.js";
import { describeError } from "../failures.js";
import type { MigrationOutcome } from "../migrate.js";
import {
  MigrationLockTimeoutError,
  type ReleaseStep,
  releaseStepFailure,
} from "../migration-lock.js";

/**
 * What `pnpm db:migrate`, `pnpm db:seed` (and the Compose `migrate` service,
 * which runs both) and `src/cli/migrate-and-seed.ts` - the migrations and the
 * seed in one process, the entry point of the `migrate` image from E0-12J -
 * actually do, without the process around them.
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
 * only the close fails, that is the failure, as `afterBody` puts it.
 */
function closeAfter<T>(
  body: () => Promise<T>,
  close: () => Promise<void>,
  output: CliOutput,
  afterBody?: (closeError: unknown, result: T) => unknown,
): Promise<T> {
  return withCleanup(body, close, reportCloseAlsoFailed(output), afterBody);
}

/** Writes the failure of a close that followed a failure of the run. */
function reportCloseAlsoFailed(output: CliOutput): (error: unknown) => void {
  return (closeError) => {
    output.err(
      `closing the database connection also failed: ${describeError(closeError)}`,
    );
  };
}

export interface MigrateCliSteps {
  /**
   * Applies the migrations; a failure of a step that puts the session back
   * afterwards goes to `onReleaseError` with the step's name instead of
   * failing the run (`migrateDb`).
   */
  migrate(
    onReleaseError: (step: ReleaseStep, error: unknown) => void,
  ): Promise<MigrationOutcome>;
  close(): Promise<void>;
}

/**
 * The migrations, a line on stderr for each step of putting the session back
 * that failed, and the line of the outcome - printed before the connection is
 * closed: a close that fails after the migrations ran must not hide what
 * they did.
 */
async function migrateAndReport(
  steps: MigrateCliSteps,
  output: CliOutput,
): Promise<MigrationOutcome> {
  const outcome = await steps.migrate((step, releaseError) => {
    output.err(releaseStepFailure(step, releaseError));
  });
  output.out(
    outcome.applied === 0
      ? `migrations: nothing to apply, ${outcome.total} already applied`
      : `migrations: applied ${outcome.applied}, ${outcome.total} in total`,
  );
  return outcome;
}

/**
 * A close that failed after the run did its work: the run's own failure
 * (exit code 1), in one line that says what the run had done - applied
 * migrations or found none to apply, and seeded the settings when it did.
 */
function closeFailedAfterRun(
  closeError: unknown,
  outcome: MigrationOutcome,
  seeded: boolean,
): CliError {
  const migrations =
    outcome.applied === 0
      ? "found no migrations to apply"
      : `applied ${outcome.applied} migration${outcome.applied === 1 ? "" : "s"}`;
  const done = seeded ? `${migrations} and seeded the settings` : migrations;
  return new CliError(
    `closing the database connection failed after the run ${done}: ${describeError(closeError)}`,
    { cause: closeError },
  );
}

/**
 * `db:migrate`: applies pending migrations and says how many it applied. A
 * step of putting the session back that failed is written to stderr by name;
 * the run still succeeds, because the migrations are applied and closing the
 * connection ends the lock with the session.
 */
export async function runMigrateCli(
  steps: MigrateCliSteps,
  output: CliOutput,
): Promise<void> {
  await closeAfter(
    () => migrateAndReport(steps, output),
    steps.close,
    output,
    (closeError, outcome) => closeFailedAfterRun(closeError, outcome, false),
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

export type SetupCliSteps = MigrateCliSteps & Pick<SeedCliSteps, "seed">;

/**
 * The migrations and then the seed on one connection (`migrate-and-seed.ts`).
 * The seed does not run after a failed migration; a failed step of putting
 * the session back is a line on stderr and does not stop it. The seed does
 * not ask for its table first, as `db:seed` does: the migrations that create
 * it have just run, and a table still missing is the driver's error to show,
 * not a hint to run them. The outcome of the migrations and `app settings
 * seeded` are printed before the one close.
 */
export async function runSetupCli(
  steps: SetupCliSteps,
  output: CliOutput,
): Promise<void> {
  await closeAfter(
    async () => {
      const outcome = await migrateAndReport(steps, output);
      await steps.seed();
      output.out("app settings seeded");
      return outcome;
    },
    steps.close,
    output,
    (closeError, outcome) => closeFailedAfterRun(closeError, outcome, true),
  );
}

/**
 * Runs an entry point and answers with its exit code. A `CliError` and a
 * `MigrationLockTimeoutError` are printed as their message; anything else
 * keeps its stack, because nobody has written a better explanation for it yet.
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
      error instanceof CliError || error instanceof MigrationLockTimeoutError
        ? error.message
        : describeError(error, { stack: true }),
    );
    return 1;
  }
}
