import type { Redis } from "ioredis";
import { authFailure, connectionFailure } from "./connection-failure.js";

/**
 * How long an unmarked connection failure of a `Worker` silences the next one
 * when the worker does not say `ready` in between (`workerErrorPolicy`).
 */
export const CONNECTION_FAILURE_LOG_WINDOW_MS = 60_000;

/** The errors one shared client emitted, and the way to stop collecting them. */
export interface ClientErrors {
  /** Whether this is the very object the client emitted as an `error`. */
  has(err: unknown): boolean;
  /**
   * Whether a listener on a `Queue` that runs on the client only has nothing
   * to write: an error of the client (its own line has it), a connection
   * failure (the client reports it, and every `Queue` would repeat it) or a
   * refusal of the credentials (the same refusal on every connection). Not
   * for a `Worker`, whose rule is `workerErrorPolicy`.
   */
  writtenByClient(err: unknown): boolean;
  /** Takes the listener off the client; nothing is marked after this. */
  dispose(): void;
}

/**
 * Marks every error the shared client emits, so that a listener further down
 * can tell a copy of it from an error of its own.
 *
 * BullMQ hands every error of the client it runs on to every `Queue` and
 * `Worker` on it (`RedisConnection` re-emits the `error` of the client), and
 * the client reports its own at a level that fades. A wrong password or a
 * name Docker cannot resolve yet would otherwise be one line per `Queue` or
 * `Worker` per reconnect, with nothing to tell them apart. The mark covers the
 * shared client only: a `Worker` also reports the errors of its own blocking
 * copy of it, which are other objects (`workerErrorPolicy` decides on those).
 * Such an error is recognised as the object the client emitted a moment
 * before: call this before the first `Queue` or `Worker` is built on the
 * client, so that its listener runs ahead of theirs and the copy they hear is
 * already marked - nothing of BullMQ is needed but the order of the
 * listeners.
 *
 * One mark per client: the queue factory makes it (`QueueFactory.clientErrors`)
 * and everything else built on the client reads that one. `dispose()` once
 * nothing built on the client can hear it any more: after the last `Queue` or
 * `Worker` on it is closed.
 */
export function markClientErrors(connection: Redis): ClientErrors {
  const fromClient = new WeakSet<object>();
  const mark = (err: unknown): void => {
    if (typeof err === "object" && err !== null) {
      fromClient.add(err);
    }
  };
  connection.on("error", mark);
  const has = (err: unknown): boolean =>
    typeof err === "object" && err !== null && fromClient.has(err);
  return {
    has,
    writtenByClient(err: unknown): boolean {
      return (
        has(err) || connectionFailure(err) !== undefined || authFailure(err)
      );
    },
    dispose(): void {
      connection.off("error", mark);
    },
  };
}

/** What the `error` listener of one `Worker` asks before it writes a line. */
export interface WorkerErrorPolicy {
  /** Whether `err` deserves a `worker error` line; a written one counts. */
  shouldWrite(err: unknown): boolean;
  /** The worker said `ready`: its blocking copy of the client is back. */
  onReady(): void;
}

/**
 * The rule of the `error` listener of a `Worker` - one instance per `Worker`,
 * next to the rule of a `Queue` (`writtenByClient`), so that both read one
 * classifier. In this order:
 *
 * - an error of the shared client is not written: the client's own line has
 *   it, and every worker on the client hears the same object;
 * - a refusal of the credentials is not written either: each `Worker` holds a
 *   blocking copy of the client of its own (BullMQ duplicates it), and with a
 *   wrong password every copy is refused on every reconnect - one line per
 *   worker per reconnect, while the shared client already says it once at a
 *   level that fades;
 * - an unmarked connection failure - the copy lost its socket, which nobody
 *   else reports - is written once, and again after either of two things: the
 *   worker says `ready` (its copy came back), or `windowMs` has passed since
 *   the last line, by the monotonic clock (`performance.now()`): a wall clock
 *   set back would keep the window shut for as long as it went back. The
 *   window is for an unmarked failure that is not the copy's (a
 *   `ConnectionClosedError` of `run()`): no `ready` follows it, and without
 *   the window it would silence the next outage of the copy for good. At
 *   worst a line per worker per window, not one per reconnect
 *   (docs/DECISIONS.md, Т9 E0-12G);
 * - anything else is a defect of the worker, and is written.
 */
export function workerErrorPolicy(
  clientErrors: Pick<ClientErrors, "has">,
  options: { windowMs?: number } = {},
): WorkerErrorPolicy {
  const windowMs = options.windowMs ?? CONNECTION_FAILURE_LOG_WINDOW_MS;
  let connectionFailureWrittenAt: number | undefined;
  return {
    shouldWrite(err: unknown): boolean {
      if (clientErrors.has(err) || authFailure(err)) {
        return false;
      }
      if (connectionFailure(err) === undefined) {
        return true;
      }
      const now = performance.now();
      if (
        connectionFailureWrittenAt !== undefined &&
        now - connectionFailureWrittenAt < windowMs
      ) {
        return false;
      }
      connectionFailureWrittenAt = now;
      return true;
    },
    onReady(): void {
      connectionFailureWrittenAt = undefined;
    },
  };
}
