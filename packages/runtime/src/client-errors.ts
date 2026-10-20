import type { Redis } from "ioredis";
import { connectionFailure } from "./connection-failure.js";

/** The errors one shared client emitted, and the way to stop collecting them. */
export interface ClientErrors {
  /** Whether this is the very object the client emitted as an `error`. */
  has(err: unknown): boolean;
  /**
   * Whether a listener on a `Queue` that runs on the client only has nothing
   * to write: an error of the client (its own line has it) or a connection
   * failure (the client reports it, and every `Queue` would repeat it). Not
   * for a `Worker`: the errors of its blocking copy of the client are its own.
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
 * copy of it, which are other objects (a wrong password there is still a line
 * per worker per reconnect - docs/TECH_DEBT.md § E0-12R). Such an error is
 * recognised as the object the client emitted a moment before: call this
 * before the first `Queue` or `Worker` is built on the client, so that its
 * listener runs ahead of theirs and the copy they hear is already marked -
 * nothing of BullMQ is needed but the order of the listeners.
 *
 * `dispose()` once nothing built on the client can hear it any more: after the
 * last `Queue` or `Worker` on it is closed.
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
      return has(err) || connectionFailure(err) !== undefined;
    },
    dispose(): void {
      connection.off("error", mark);
    },
  };
}
