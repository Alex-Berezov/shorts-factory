/**
 * Runs `work`, but gives up on it after `timeoutMs` and answers `fallback`.
 *
 * Every promise a command line tool of this app holds can be one that never
 * settles: the worker's connection has no request retry limit and an offline
 * queue (BullMQ's requirement, `lib/redis.ts`), so a command issued while
 * Redis is down waits for a socket instead of failing, and a Redis that takes
 * the connection and never answers leaves even a fail-fast client waiting.
 * `Promise.race` with a real timer is the only thing between that and a
 * command with no output and no exit code.
 *
 * Shared by the smoke command (`cli/smoke.ts`, `cli/smoke-run.ts`) and the
 * container healthcheck (`cli/healthcheck-run.ts`). One of the copies of "a
 * promise under a deadline" that docs/TECH_DEBT.md lists to be merged.
 */
export async function settleWithin<T, F>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
