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
 * Signal handler that closes the worker's resources in order and exits.
 *
 * A copy of the api handler in shape (importing across apps is forbidden by §6
 * of the System Design; a third consumer moves it into a package - see
 * docs/TECH_DEBT.md) and different in what it guards:
 *
 * - **order**: the stages above, workers first, because `worker.close()` is
 *   what waits for the job in flight;
 * - **idempotence**: an operator presses Ctrl+C twice, and a container gets
 *   SIGTERM followed by SIGINT. A second pass would call `close()` on a worker
 *   that is already closing and turn a clean stop into an error;
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
      options.log.info({ signal, failed }, "shutdown already in progress");
      return;
    }
    started = true;
    options.log.info({ signal }, "shutdown started, draining active jobs");

    const forceTimer = setTimeout(() => {
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
