/**
 * The shared bound of every dependency call the api makes on behalf of a
 * request: the probes of `/health` (`lib/health.ts`) and the sections of
 * `/system/status` (`lib/system-status.ts`).
 *
 * One number for both, because they answer the same question - is the
 * dependency there - and two constants of one threshold drift apart on the
 * first edit. It sits well under the `timeout: 5s` of the api healthcheck in
 * `infra/docker-compose.app.yml`, so a dependency that is down shows up as a
 * 503 the healthcheck reads rather than as a healthcheck that timed out.
 */
export const DEPENDENCY_TIMEOUT_MS = 2_000;

/** What a call that ran out of its deadline is reported as. */
export class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`deadline of ${timeoutMs}ms expired`);
    this.name = "DeadlineError";
  }
}

/**
 * Runs something under a deadline.
 *
 * The deadline is the point: a TCP connection to a machine that stopped
 * answering neither resolves nor rejects, so a call to a dependency without
 * one would hold the request open until the client gives up - and a page about
 * the state of the system has to answer during the incident that made it worth
 * opening.
 *
 * It does not cancel the work: a call that outlives its deadline keeps going
 * until its driver gives up on it (the Redis client by its `commandTimeout`
 * in `lib/redis.ts`; a database query has no such bound) and the pile-up of
 * such calls is bounded by `singleFlight` (`lib/single-flight.ts`) instead.
 * No signal is handed to `run` on purpose: the calls it guards are shared
 * between callers, and one caller cancelling on its own deadline would cancel
 * the call for every caller that joined it. Cancelling the database probe is
 * left to E0-12B (docs/TECH_DEBT.md, rows of E0-11B).
 */
export async function withDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
