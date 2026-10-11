/**
 * A close that did its job, but not the clean way: the target is closed, and
 * the stop says how with a `warn` line instead of `closed` - without failing
 * the exit code over it.
 */
interface CloseWarning {
  /** The message of the `warn` line. */
  warning: string;
  /** What made the clean way impossible. */
  err: unknown;
}

/**
 * Anything with an asynchronous close: Fastify, the database, Redis. A close
 * that resolves with a `CloseWarning` went the other way and says so; what
 * else a close resolves with is no business of the stop.
 */
export interface ShutdownTarget {
  // Two promises rather than `Promise<CloseWarning | void>`, which biome
  // rejects (`noConfusingVoidType`); either way `isCloseWarning` decides.
  close(): Promise<void> | Promise<CloseWarning | undefined>;
}

/**
 * Whether a close answered with a warning. Checked by shape rather than by
 * "anything but `undefined`": a close is typed `void` and may still resolve
 * with a value of its own - the instance it closed, a count - and read as a
 * warning that would be a `warn` line with no message in a clean stop.
 */
function isCloseWarning(value: unknown): value is CloseWarning {
  return (
    typeof value === "object" &&
    value !== null &&
    "warning" in value &&
    typeof value.warning === "string" &&
    "err" in value
  );
}

/** The part of the pino logger a shutdown writes to. */
export interface ShutdownLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ShutdownOptions {
  /** Closed first: Fastify stops accepting and drains in-flight requests. */
  app: ShutdownTarget;
  /** Closed once no handler can be using it any more. */
  db: ShutdownTarget;
  /**
   * The `Queue` objects of `/system/status`, closed before the connection they
   * were opened on: BullMQ ends its own reads through that client, and a
   * socket torn down first leaves them waiting for a reply that cannot come.
   */
  queues: ShutdownTarget;
  /** The Redis client, closed after the queues that run on it. */
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
 *   connection. After it, two branches at once, because nothing in one waits
 *   for the other: the driver on its own, and the queue objects followed by
 *   the Redis client they use. Run in a line, a database that never finishes
 *   closing would leave Redis open until the deadline killed the process;
 *   inside the Redis branch the order stays, for the reason on `queues`;
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
 * A close that answers with a `CloseWarning` is not one of them - the target
 * is closed - but it did not close the clean way, and the log says so.
 */
export function createShutdownHandler(
  options: ShutdownOptions,
): (signal: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const { log } = options;
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

  /**
   * Closes one target and writes its line: `closed`, the warning the target
   * answered with, or `close failed`; `false` only for the last.
   */
  const close = async (
    signal: string,
    target: string,
    run: ShutdownTarget["close"],
  ): Promise<boolean> => {
    try {
      const answer: unknown = await run();
      if (isCloseWarning(answer)) {
        log.warn({ signal, target, err: answer.err }, answer.warning);
      } else {
        log.info({ signal, target }, "closed");
      }
      return true;
    } catch (err) {
      log.error({ signal, target, err }, "close failed");
      return false;
    }
  };

  return async (signal: string): Promise<void> => {
    if (started) {
      log.info({ signal }, "shutdown already in progress");
      return;
    }
    started = true;
    log.info({ signal }, "shutdown started");

    const forceTimer = setTimeout(() => {
      log.error({ signal, timeoutMs }, "shutdown timed out, exiting");
      exitOnce(1);
    }, timeoutMs);

    const appClosed = await close(signal, "app", () => options.app.close());
    const [dbClosed, redisClosed] = await Promise.all([
      close(signal, "db", () => options.db.close()),
      (async (): Promise<boolean> => {
        // Every close is attempted: a failed close of the queues is no reason
        // to leave the client they ran on open.
        const queuesClosed = await close(signal, "queues", () =>
          options.queues.close(),
        );
        const clientClosed = await close(signal, "redis", () =>
          options.redis.close(),
        );
        return queuesClosed && clientClosed;
      })(),
    ]);
    const failed = !(appClosed && dbClosed && redisClosed);

    clearTimeout(forceTimer);
    log.info({ signal, failed }, "shutdown complete");
    exitOnce(failed ? 1 : 0);
  };
}
