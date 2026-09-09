/** Anything with an asynchronous close: Fastify, the database, Redis. */
export interface ShutdownTarget {
  close(): Promise<unknown>;
}

/** The part of the pino logger a shutdown writes to. */
export interface ShutdownLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ShutdownOptions {
  /** Closed first: Fastify stops accepting and drains in-flight requests. */
  app: ShutdownTarget;
  /** Closed once no handler can be using it any more. */
  db: ShutdownTarget;
  redis: ShutdownTarget;
  log: ShutdownLogger;
  /** Deadline for the whole sequence. */
  timeoutMs?: number;
  /** Seam for tests; the process really does exit in production. */
  exit?: (code: number) => void;
}

/** How long the sequence gets before the process is torn down anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Signal handler that closes the process resources in order and exits.
 *
 * Three properties, each of them a way this goes wrong without care:
 *
 * - **order**: Fastify first, so a request in flight still has its database
 *   connection; the driver and Redis after it;
 * - **idempotence**: an operator presses Ctrl+C twice, and a container gets
 *   SIGTERM followed by SIGINT. A second pass would call `quit()` on a client
 *   that is already closing and turn a clean stop into an error;
 * - **a deadline**: a socket that never finishes closing would leave the
 *   process hanging until the orchestrator kills it, losing the exit code.
 *   The deadline is a live timer on purpose - an `unref`ed one lets the
 *   process leave with code 0 the moment nothing else holds the loop, and
 *   "did not close in ten seconds" becomes indistinguishable from a clean
 *   stop - and the whole shutdown exits exactly once: whichever verdict comes
 *   first is the one the orchestrator sees, so a close that finishes just
 *   after the deadline cannot overwrite the timeout with a success.
 *
 * Failures are logged and reflected in the exit code rather than swallowed:
 * a stop that did not close what it claimed to close must not look successful.
 */
export function createShutdownHandler(
  options: ShutdownOptions,
): (signal: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const targets: ReadonlyArray<[string, ShutdownTarget]> = [
    ["app", options.app],
    ["db", options.db],
    ["redis", options.redis],
  ];
  let started = false;
  let exited = false;

  /** The process leaves once, with the verdict that was reached first. */
  const exitOnce = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    exit(code);
  };

  return async (signal: string): Promise<void> => {
    if (started) {
      options.log.info({ signal }, "shutdown already in progress");
      return;
    }
    started = true;
    options.log.info({ signal }, "shutdown started");

    const forceTimer = setTimeout(() => {
      options.log.error({ signal, timeoutMs }, "shutdown timed out, exiting");
      exitOnce(1);
    }, timeoutMs);

    let failed = false;
    for (const [name, target] of targets) {
      try {
        await target.close();
        options.log.info({ signal, target: name }, "closed");
      } catch (err) {
        failed = true;
        options.log.error({ signal, target: name, err }, "close failed");
      }
    }

    clearTimeout(forceTimer);
    options.log.info({ signal, failed }, "shutdown complete");
    exitOnce(failed ? 1 : 0);
  };
}
