import { settleWithin } from "./deadline.js";
import type { RuntimeLogger } from "./runtime-logger.js";

/**
 * A close that did its job, but not the clean way: the target is closed, and
 * the stop says how with a `warn` line instead of `closed` - without failing
 * the exit code over it.
 */
export interface CloseWarning {
  /** The message of the `warn` line. */
  warning: string;
  /** What made the clean way impossible, when something did. */
  err?: unknown;
}

/**
 * What a close answers when there was nothing to close: the stop came before
 * the target was opened - a start that failed halfway, a signal in the start
 * window. Written as such rather than as `closed`, which would tell the
 * operator that something was up and went down.
 */
export const NOT_OPENED: unique symbol = Symbol("not opened");

/**
 * One named thing with an asynchronous close: a server, the workers, the
 * queues, a connection. A close that resolves with a `CloseWarning` went the
 * other way and says so, one that resolves with `NOT_OPENED` had nothing to
 * close; what else a close resolves with is no business of the stop.
 */
export interface ShutdownStage {
  name: string;
  close(): Promise<unknown>;
}

/**
 * A stage over a target that may not exist when the stop runs: a start that
 * failed halfway, a signal in the start window. `target` is read when the stop
 * runs, not when the plan is built - the plan exists before anything is
 * opened - and may be a promise of the target, for a start still in flight. No
 * target is `NOT_OPENED`; otherwise `close` gets it, and its answer (a
 * `CloseWarning`, say) is the answer of the stage.
 *
 * Every stage of a resource is built this way, so that "never opened" is said
 * the same way by every process instead of each stage checking on its own -
 * and a stage that forgets the check writes `closed` for what never was.
 */
export function stageOf<T>(
  name: string,
  target: () => T | undefined | PromiseLike<T | undefined>,
  close: (opened: T) => Promise<unknown>,
): ShutdownStage {
  return {
    name,
    close: async (): Promise<unknown> => {
      const opened = await target();
      if (opened === undefined) {
        return NOT_OPENED;
      }
      return close(opened);
    },
  };
}

/**
 * Sequences that run side by side, each of them in its own order: nothing in
 * one waits for the other, and a target in one that never finishes closing
 * must not hold the targets of the others open.
 */
interface ParallelStages {
  parallel: ReadonlyArray<readonly ShutdownStage[]>;
}

/** A step of the plan: one stage, or sequences that run side by side. */
export type ShutdownStep = ShutdownStage | ParallelStages;

/** The logger of the package, and the flush a stop needs before the exit. */
interface ShutdownLogger extends RuntimeLogger {
  /** Writes out what the transport still holds; see `FLUSH_TIMEOUT_MS`. */
  flush(cb?: (err?: Error) => void): void;
}

/**
 * What a SIGINT after the first one does to a stop a signal began.
 *
 * `"log"`: nothing but a line - the stop goes on. Otherwise the process
 * leaves at once with 130 (128 + SIGINT), and the first SIGINT tells the
 * operator so with `hint`; `forcedMessage` is the line of the forced exit.
 */
export type RepeatedSigint = "log" | { hint: string; forcedMessage: string };

export interface ShutdownOptions {
  /** Closed in this order; the order is the contract of the caller. */
  plan: readonly ShutdownStep[];
  log: ShutdownLogger;
  /** The first line of the stop. */
  startedMessage: string;
  /** Required, so that whether Ctrl+C twice forces the exit is a choice. */
  repeatedSigint: RepeatedSigint;
  /** Deadline for the whole sequence; the number is the caller's. */
  timeoutMs: number;
  /** Seam for tests; the process really does exit in production. */
  exit?: (code: number) => void;
}

/** What the caller already knows when it asks for the stop. */
interface ShutdownRequest {
  /**
   * Something has already failed and the stop is the consequence - a start
   * that threw halfway, a port that was taken. The exit code stays non-zero
   * even when every stage closes cleanly: an orchestrator that reads 0 would
   * restart nothing and report nothing.
   *
   * It counts even when the stop is already running, which is the case this
   * exists for: a SIGTERM in the start window begins the stop, and the start
   * that fails a moment later has no other way to say the process is leaving
   * because it is broken.
   */
  failed?: boolean;
}

export type ShutdownHandler = (
  signal: string,
  request?: ShutdownRequest,
) => Promise<void>;

/**
 * How long a SIGINT after the first one still counts as the same keypress.
 *
 * One Ctrl+C under `pnpm dev` on Linux or macOS reaches the process more than
 * once: the terminal signals the whole process group, and pnpm (and turbo,
 * when it runs the task) forwards the signal it got on top of that. The copies
 * arrive within milliseconds of each other; an operator who presses Ctrl+C
 * again because the drain is too slow does it after a pause a person can
 * notice. A second it is.
 */
export const SIGINT_REPEAT_WINDOW_MS = 1_000;

/**
 * Hands SIGINT and SIGTERM to `handler`: SIGINT is Ctrl+C in a console,
 * SIGTERM is what an orchestrator sends. The production `subscribe` of every
 * entry point; a test passes its own.
 */
export function subscribeToSignals(handler: (signal: string) => void): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      handler(signal);
    });
  }
}

/**
 * How long the last lines get to leave the process before it exits.
 *
 * Under the `pino-pretty` transport of `pnpm dev` the lines go to a worker
 * thread, and `process.exit` right after `log.info` cuts off whatever that
 * thread has not written yet - "shutdown complete" and "forced exit" among
 * them, which makes a clean stop look like a crash. Bounded, because a
 * transport whose thread is gone would otherwise keep the exit waiting.
 */
const FLUSH_TIMEOUT_MS = 1_000;

/**
 * Whether a close answered with a warning. Checked by shape rather than by
 * "anything but `undefined`": a close may resolve with a value of its own -
 * the instance it closed, a count, an outcome that is no warning - and read
 * as a warning that would be a `warn` line with no message in a clean stop.
 */
function isCloseWarning(value: unknown): value is CloseWarning {
  return (
    typeof value === "object" &&
    value !== null &&
    "warning" in value &&
    typeof value.warning === "string"
  );
}

function isParallel(step: ShutdownStep): step is ParallelStages {
  return "parallel" in step;
}

/** Waits for what the logger still holds, within `FLUSH_TIMEOUT_MS`. */
async function flushed(log: ShutdownLogger): Promise<void> {
  await settleWithin(
    () =>
      new Promise<void>((resolve) => {
        try {
          // An error of the flush is nothing to act on: the exit comes next.
          log.flush(() => {
            resolve();
          });
        } catch {
          resolve();
        }
      }),
    FLUSH_TIMEOUT_MS,
    undefined,
    // Live: the exit must not be overtaken by a loop that ran empty.
    { unref: false },
  );
}

/** The verdict of the deadline, as opposed to the verdict of the plan. */
const TIMED_OUT = Symbol("timed out");

/**
 * Signal handler that closes the resources of a process in the order of its
 * plan and exits.
 *
 * Each of these is a way a stop goes wrong without care:
 *
 * - **order**: the plan. A connection closed while a job or a request still
 *   uses it loses that work - the very thing a graceful stop is for. Steps
 *   that do not wait for each other run side by side (`ParallelStages`), so
 *   that a target that never finishes closing holds only its own sequence;
 * - **one pass**: an operator presses Ctrl+C twice, and a container gets
 *   SIGTERM followed by SIGINT. A second pass would call `close()` on what is
 *   already closing and turn a clean stop into an error, so the plan runs
 *   once and a repeated call is only logged - unless `repeatedSigint` says a
 *   second Ctrl+C is a request to leave now. Then a SIGINT later than
 *   `SIGINT_REPEAT_WINDOW_MS` after a stop a signal began leaves at once with
 *   130, and a SIGINT inside the window is a copy of the first keypress and is
 *   only logged at debug. A stop the process began itself, because its start
 *   failed, has no keypress to repeat: a SIGINT there is only logged, and the
 *   exit code stays the failure's. A start that fails while a signal's stop is
 *   already running still lets a later Ctrl+C force the exit, with 1, not 130;
 * - **a deadline**: a socket that never finishes closing - a command to a
 *   Redis that is down waits forever on the queue client - would leave the
 *   process hanging until the orchestrator kills it, losing the exit code. The
 *   deadline is a live timer on purpose: an `unref`ed one lets the process
 *   leave with 0 the moment nothing else holds the loop, and "did not close in
 *   time" becomes indistinguishable from a clean stop;
 * - **one exit**: whichever verdict comes first is the one the orchestrator
 *   sees, so a close that finishes just after the deadline cannot overwrite
 *   the timeout with a success - and the log is flushed before it.
 *
 * Failures are logged and reflected in the exit code rather than swallowed: a
 * stop that did not close what it claimed to close must not look successful.
 * A close that answers with a `CloseWarning` is not one of them - the target
 * is closed - but it did not close the clean way, and the log says so.
 */
export function createShutdownHandler(
  options: ShutdownOptions,
): ShutdownHandler {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const { log, repeatedSigint } = options;
  let started = false;
  let exited = false;
  /**
   * Sticky, and shared by every caller: whoever knows the stop is the
   * consequence of a failure may say so at any point before the plan ends,
   * and the exit code is read from here when it does.
   */
  let failed = false;
  /** The stop was asked for by a signal, not by the process itself. */
  let startedBySignal = false;
  /** Set once the window has passed: a SIGINT from then on is a new keypress. */
  let repeatArmed = false;

  /** The process leaves once, with the verdict that was reached first. */
  const exitOnce = async (code: number): Promise<void> => {
    if (exited) {
      return;
    }
    exited = true;
    await flushed(log);
    exit(code);
  };

  /**
   * Closes one target and writes its line: `closed`, the warning the target
   * answered with, or `close failed`.
   */
  const close = async (signal: string, stage: ShutdownStage): Promise<void> => {
    try {
      const answer: unknown = await stage.close();
      if (answer === NOT_OPENED) {
        log.info(
          { signal, target: stage.name },
          "not opened, nothing to close",
        );
      } else if (isCloseWarning(answer)) {
        log.warn(
          {
            signal,
            target: stage.name,
            ...(answer.err === undefined ? {} : { err: answer.err }),
          },
          answer.warning,
        );
      } else {
        log.info({ signal, target: stage.name }, "closed");
      }
    } catch (err) {
      failed = true;
      log.error({ signal, target: stage.name, err }, "close failed");
    }
  };

  /** Every stage is attempted: a failed close is no reason to skip the rest. */
  const runPlan = async (signal: string): Promise<void> => {
    for (const step of options.plan) {
      if (isParallel(step)) {
        await Promise.all(
          step.parallel.map(async (sequence) => {
            for (const stage of sequence) {
              await close(signal, stage);
            }
          }),
        );
      } else {
        await close(signal, step);
      }
    }
  };

  return async (
    signal: string,
    request: ShutdownRequest = {},
  ): Promise<void> => {
    if (request.failed === true) {
      failed = true;
    }
    if (started) {
      if (repeatedSigint !== "log" && signal === "SIGINT" && startedBySignal) {
        if (!repeatArmed) {
          log.debug(
            { signal },
            "repeated SIGINT within the window, same keypress",
          );
          return;
        }
        log.error({ signal, failed }, repeatedSigint.forcedMessage);
        await exitOnce(failed ? 1 : 130);
        return;
      }
      log.info({ signal, failed }, "shutdown already in progress");
      return;
    }
    started = true;
    startedBySignal = signal === "SIGINT" || signal === "SIGTERM";
    if (repeatedSigint !== "log") {
      // Not holding the loop open: the window only matters while something
      // else - the drain, the deadline - keeps the process alive.
      setTimeout(() => {
        repeatArmed = true;
      }, SIGINT_REPEAT_WINDOW_MS).unref();
    }
    log.info(
      signal === "SIGINT" && repeatedSigint !== "log"
        ? { signal, hint: repeatedSigint.hint }
        : { signal },
      options.startedMessage,
    );

    const verdict = await settleWithin(
      () => runPlan(signal),
      options.timeoutMs,
      TIMED_OUT,
      { unref: false },
    );
    if (exited) {
      // A forced exit got there first; its code is the one that counts.
      return;
    }
    if (verdict === TIMED_OUT) {
      log.error(
        { signal, timeoutMs: options.timeoutMs },
        "shutdown timed out, exiting",
      );
      await exitOnce(1);
      return;
    }
    log.info({ signal, failed }, "shutdown complete");
    await exitOnce(failed ? 1 : 0);
  };
}
