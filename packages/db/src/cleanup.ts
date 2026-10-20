/**
 * Runs `body`, then `cleanup`, and decides which failure is the one to throw.
 *
 * When the body fails, its error is thrown and a failure of the cleanup is
 * handed to `onCleanupError` instead: the cleanup - closing a connection,
 * releasing a lock on it - usually fails on the very connection that broke the
 * body, and throwing that would send the diagnosis after the wrong cause. When
 * only the cleanup fails, that is the failure - as `afterBody` puts it from
 * the failure and what the body returned, which may say what the body had
 * done before it; the failure itself by default.
 *
 * The policy of the entry points of `src/cli/run.ts`, which write the
 * swallowed cleanup failure to stderr and say what a failed close came after
 * (the migrations it applied, the seed). `runMigrations` reports every
 * failure instead (`throwFailures` in `failures.ts`); the lock of `migrateDb`
 * is released by steps whose failures go, by name, to `onReleaseError`.
 */
export async function withCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  onCleanupError: (error: unknown) => void,
  afterBody: (cleanupError: unknown, result: T) => unknown = (cleanupError) =>
    cleanupError,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      onCleanupError(cleanupError);
    }
    throw error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    throw afterBody(cleanupError, result);
  }
  return result;
}
