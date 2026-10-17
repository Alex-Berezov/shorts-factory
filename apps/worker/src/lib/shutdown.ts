import type { Logger } from "pino";

/** One step of the sequence: a named thing with an asynchronous close. */
export interface ShutdownStage {
  name: string;
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  /**
   * Closed in this order, and the order is the contract:
   * workers (each one draining its active jobs), then the queues and their
   * event streams, then Redis, then the database. A connection closed while a
   * job is still running loses that job - the very thing the graceful stop is
   * for - and closing Redis before the workers takes away the socket they need
   * to release their locks.
   */
  stages: readonly ShutdownStage[];
  log: Logger;
  /** Deadline for the whole sequence. */
  timeoutMs?: number;
  /** Seam for tests; the process really does exit in production. */
  exit?: (code: number) => void;
}

/** What the caller already knows when it asks for the stop. */
export interface ShutdownRequest {
  /**
   * Something has already failed and the stop is the consequence - a start
   * that threw halfway, for instance. The exit code stays non-zero even when
   * every stage closes cleanly: an orchestrator that reads 0 would restart
   * nothing and report nothing.
   *
   * It counts even when the stop is already running, which is the case this
   * exists for: a SIGTERM in the start window begins the stop, and the start
   * that fails a moment later has no other way to say the process is leaving
   * because it is broken.
   */
  failed?: boolean;
}

/**
 * How long the sequence gets before the process is torn down anyway. Longer
 * than the api's ten seconds: the first stage waits for jobs that are running,
 * and a job is allowed to take longer than a request.
 *
 * Whoever sent the signal has a deadline of its own, and it is shorter than
 * this one by default: `docker stop` - and Compose with it - sends SIGKILL ten
 * seconds after the signal unless the service declares `stop_grace_period`.
 * So this number only holds where that is declared, and E0-11 declares it
 * (`stop_grace_period: 30s` on the worker service, docs/30_E0_TASKS.md). Under
 * a shorter grace the container is killed mid-drain and the exit code is not
 * ours: a job in flight comes back through the stalled scan instead.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * How long a SIGINT after the first one still counts as the same keypress.
 *
 * One Ctrl+C under `pnpm dev` on Linux or macOS reaches this process more than
 * once: the terminal signals the whole process group, and pnpm (and turbo,
 * when it runs the task) forwards the signal it got on top of that. The copies
 * arrive within milliseconds of each other; an operator who presses Ctrl+C
 * again because the drain is too slow does it after a pause a person can
 * notice. A second it is.
 */
export const SIGINT_REPEAT_WINDOW_MS = 1_000;

/** What the operator is told on the first Ctrl+C, while the drain runs. */
const SIGINT_HINT =
  "press Ctrl+C again to exit now; unfinished jobs will be retried";

/**
 * Signal handler that closes the worker's resources in order and exits.
 *
 * A copy of the api handler in shape (importing across apps is forbidden by §6
 * of the System Design; a third consumer moves it into a package - see
 * docs/TECH_DEBT.md) and different in what it guards:
 *
 * - **order**: the stages above, workers first, because `worker.close()` is
 *   what waits for the job in flight;
 * - **one pass, and a way out of it**: a second pass would call `close()` on
 *   a worker that is already closing and turn a clean stop into an error, so
 *   the stages run once. A repeated SIGTERM (or any other repeated call) is
 *   only logged. A SIGINT that comes later than `SIGINT_REPEAT_WINDOW_MS`
 *   after a stop a signal began is an operator pressing Ctrl+C again because
 *   they do not want to wait for the drain - up to the deadline below: the
 *   process leaves at once with 130 (128 + SIGINT) and the jobs it was running
 *   come back to the queue as stalled, which is safe because every job is
 *   idempotent. The first SIGINT says so in its line. The same holds for a
 *   SIGINT after a SIGTERM; Compose only ever sends SIGTERM, so the graceful
 *   stop of a container is not affected. A SIGINT inside the window is a copy
 *   of the first keypress and is only logged at debug. A stop the process
 *   began itself, because its start failed, has no keypress to repeat and
 *   nothing stalled to warn about: a SIGINT there is only logged, and the exit
 *   code stays the failure's. A start that fails while a signal's stop is
 *   already running still lets a later Ctrl+C force the exit, with 1, not 130;
 * - **a deadline**: with `maxRetriesPerRequest: null` a command to a Redis
 *   that is down waits forever, so without a live timer the process would hang
 *   there instead of exiting. The timer is not `unref`ed on purpose - an
 *   unreferenced one lets the process leave with 0 the moment nothing else
 *   holds the loop, and "did not close in time" would be indistinguishable
 *   from a clean stop - and the shutdown exits exactly once: whichever verdict
 *   comes first is the one the orchestrator sees.
 *
 * Failures are logged and reflected in the exit code: a stop that did not
 * close what it claimed to close must not look successful.
 */
export function createShutdownHandler(
  options: ShutdownOptions,
): (signal: string, request?: ShutdownRequest) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  let exited = false;
  /**
   * Sticky, and shared by every caller: whoever knows the stop is the
   * consequence of a failure may say so at any point before the last stage
   * closes, and the exit code is read from here when the sequence ends.
   */
  let failed = false;
  /** Out here so that a forced exit can take the deadline down with it. */
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The stop was asked for by a signal, not by the process itself. */
  let startedBySignal = false;
  /** Set once the window has passed: a SIGINT from then on is a new keypress. */
  let repeatArmed = false;

  /** The process leaves once, with the verdict that was reached first. */
  const exitOnce = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    exit(code);
  };

  return async (
    signal: string,
    request: ShutdownRequest = {},
  ): Promise<void> => {
    if (request.failed === true) {
      failed = true;
    }
    if (started) {
      if (signal === "SIGINT" && startedBySignal) {
        if (!repeatArmed) {
          options.log.debug(
            { signal },
            "repeated SIGINT within the window, same keypress",
          );
          return;
        }
        options.log.error(
          { signal, failed },
          "forced exit, active jobs return as stalled",
        );
        clearTimeout(forceTimer);
        exitOnce(failed ? 1 : 130);
        return;
      }
      options.log.info({ signal, failed }, "shutdown already in progress");
      return;
    }
    started = true;
    startedBySignal = signal === "SIGINT" || signal === "SIGTERM";
    // Not holding the loop open: the window only matters while something
    // else - the drain, the deadline - keeps the process alive.
    setTimeout(() => {
      repeatArmed = true;
    }, SIGINT_REPEAT_WINDOW_MS).unref();
    options.log.info(
      signal === "SIGINT" ? { signal, hint: SIGINT_HINT } : { signal },
      "shutdown started, draining active jobs",
    );

    forceTimer = setTimeout(() => {
      options.log.error({ signal, timeoutMs }, "shutdown timed out, exiting");
      exitOnce(1);
    }, timeoutMs);

    for (const stage of options.stages) {
      try {
        await stage.close();
        options.log.info({ signal, target: stage.name }, "closed");
      } catch (err) {
        failed = true;
        options.log.error({ signal, target: stage.name, err }, "close failed");
      }
    }

    clearTimeout(forceTimer);
    options.log.info({ signal, failed }, "shutdown complete");
    exitOnce(failed ? 1 : 0);
  };
}
