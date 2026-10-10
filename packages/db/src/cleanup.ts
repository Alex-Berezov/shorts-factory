/**
 * Runs `body`, then `cleanup`, and decides which failure is the one to throw.
 *
 * When the body fails, its error is thrown and a failure of the cleanup is
 * handed to `onCleanupError` instead: the cleanup - closing a connection,
 * releasing a lock on it - usually fails on the very connection that broke the
 * body, and throwing that would send the diagnosis after the wrong cause. When
 * only the cleanup fails, that is the failure.
 *
 * The one policy behind `runMigrations` and the entry points of `src/cli/` -
 * they differ only in what they do with the swallowed cleanup failure. (The
 * lock of `migrateDb` is released by steps that never throw, so it needs no
 * choice between two failures.)
 */
export async function withCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  onCleanupError: (error: unknown) => void,
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
  await cleanup();
  return result;
}
