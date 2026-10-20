/**
 * "A promise under a deadline", the one primitive of every process here.
 *
 * The deadline is the point: a TCP connection to a machine that stopped
 * answering neither resolves nor rejects, and a client built for BullMQ
 * (`maxRetriesPerRequest: null`, offline queue on) keeps a command issued
 * while Redis is down waiting for a socket instead of failing it. Without a
 * real timer racing the work, a request, a command line tool or a shutdown
 * waits for as long as the outage lasts.
 *
 * It does not cancel the work: what outlives its deadline keeps going until
 * its driver gives up on it. No signal is handed to the work on purpose - the
 * calls it guards are often shared between callers (`singleFlight` in the
 * api), and one caller cancelling on its own deadline would cancel the call
 * for every caller that joined it. The bound on how long such work lives is
 * the driver's: a Redis command ends by the `commandTimeout` of its client,
 * a database query of a probe by the limit of its handle (`createProbeDb` of
 * `@sf/db`, which destroys the connection the query hangs on) and, once that
 * handle is closed, by the bound of its close (`closeDb({ timeoutSec })`).
 *
 * Whether the timer holds the process open is the caller's choice, and a
 * required one (`unref`): a deadline that bounds a request or a shutdown has
 * to fire even when nothing else keeps the loop alive, while a deadline in
 * front of a cache command must not be the reason a stopping process stays up.
 * The two copies this replaced had drifted on exactly that.
 */

/** What a call that ran out of its deadline is reported as by default. */
export class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`deadline of ${timeoutMs}ms expired`);
    this.name = "DeadlineError";
  }
}

/** Whether the timer of the deadline keeps the process alive. */
interface TimerOptions {
  /**
   * `true`: the timer does not hold the loop open - the process may leave
   * before it fires. `false`: it does, and the deadline always gets its say.
   */
  unref: boolean;
}

interface DeadlineOptions extends TimerOptions {
  /** The error the expiry rejects with; `DeadlineError` when left out. */
  error?: () => Error;
}

/**
 * The core: `work` against a timer that settles the race its own way. The
 * timer is cleared once the race is decided, whichever side decided it.
 */
async function race<T, F>(
  work: () => Promise<T>,
  timeoutMs: number,
  unref: boolean,
  expire: (resolve: (value: F) => void, reject: (err: unknown) => void) => void,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      expire(resolve, reject);
    }, timeoutMs);
    if (unref) {
      timer.unref();
    }
  });

  try {
    return await Promise.race([work(), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `run` and rejects once `timeoutMs` passes without an answer - with a
 * `DeadlineError`, or with the error the caller names (`options.error`) when
 * the failure has a meaning of its own where it is used.
 */
export async function withDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  options: DeadlineOptions,
): Promise<T> {
  const error = options.error ?? (() => new DeadlineError(timeoutMs));
  return race<T, never>(run, timeoutMs, options.unref, (_resolve, reject) => {
    reject(error());
  });
}

/**
 * Runs `run` and answers `fallback` once `timeoutMs` passes without an
 * answer: for a caller that has a verdict for "no answer" and must never
 * hang - a command line tool, a healthcheck, the close of a service.
 */
export async function settleWithin<T, F>(
  run: () => Promise<T>,
  timeoutMs: number,
  fallback: F,
  options: TimerOptions,
): Promise<T | F> {
  return race<T, F>(run, timeoutMs, options.unref, (resolve) => {
    resolve(fallback);
  });
}
