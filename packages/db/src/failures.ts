import { errorCode } from "@sf/core";

/**
 * How the migration runner and its entry points put a failure into words -
 * one place, so that `runMigrations` and `pnpm db:migrate` say the same
 * failure the same way. Knows nothing of the runner itself: the names of its
 * steps live in `migration-lock.ts` (the lock and its release) and
 * `migrate.ts` (`count_journal`), which both read this module, never the
 * other way round.
 */

/** The message of a failure, or its stack when `stack` is asked for. */
export function describeError(
  error: unknown,
  opts?: { stack: boolean },
): string {
  if (error instanceof Error) {
    return (opts?.stack === true ? error.stack : undefined) ?? error.message;
  }
  return String(error);
}

/**
 * Throws what a run with these failures ends in: nothing when there are none,
 * the failure itself when there is one - its class and `code` intact - and
 * an `AggregateError` of all of them, in the order given, when there are
 * several. The message of that one names every failure with its code: a
 * stack trace printed at the edge of the process shows the message, and
 * the second failure must not get lost behind the first. A thrown
 * `undefined` counts as a failure like any other value.
 */
export function throwFailures(failures: readonly unknown[]): void {
  const [first] = failures;
  if (failures.length === 0) return;
  if (failures.length === 1) throw first;
  throw new AggregateError(
    failures,
    `${failures.length} failures: ${failures.map(describeFailure).join("; ")}`,
  );
}

/**
 * One failure in one line, with the code of the driver's error - its own or
 * that of the error it wraps - in brackets.
 */
function describeFailure(error: unknown): string {
  const code =
    errorCode(error) ??
    (error instanceof Error ? errorCode(error.cause) : undefined);
  const message = describeError(error);
  return code === undefined ? message : `${message} [${code}]`;
}
