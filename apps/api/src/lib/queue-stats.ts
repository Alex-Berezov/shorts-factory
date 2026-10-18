import type { DlqStatus, QueueStatus } from "@sf/contracts";
import { QUEUE_NAMES, type QueueName } from "@sf/core";
import { type RuntimeLogger, createQueueFactory } from "@sf/runtime";
import type { Redis } from "ioredis";
import type { QueueStatsProbe, QueuesSnapshot } from "../deps.js";
import { singleFlight } from "./single-flight.js";

/** The queue whose depth is the DLQ size; it has no processor of its own. */
const DLQ_QUEUE: QueueName = "system.dlq";

/**
 * bullmq answered, and the answer was not one this code can read.
 *
 * A defect of ours - a counter renamed in a release of the library, a queue
 * missing from a pass that asked for all of them - and never a failure of
 * Redis: reported as `redis: down` it would send an operator to restart a
 * server that is answering every command (decision of 13.09.2026). It leaves
 * as a 500 with the request id in the log, like any other defect.
 *
 * What it must not become is a zero. `waiting: 0` reads as "nothing to do",
 * and the whole point of the nullable sections is that "no data" and "0" are
 * different answers (decision of 13.09.2026, Р5).
 */
export class QueueCountersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueCountersError";
  }
}

/** Everything the api owns for reading queue state, including its teardown. */
export interface QueueStats extends QueueStatsProbe {
  /** Closes the `Queue` objects; the connection belongs to the caller. */
  close(): Promise<void>;
}

export interface QueueStatsOptions {
  connection: Redis;
  /** Where an error of a `Queue` that is not a connection failure goes. */
  log: RuntimeLogger;
  /**
   * How long `close()` waits for a pass still reading; the factory's bound
   * when left out. Overridable by tests.
   */
  drainTimeoutMs?: number;
}

/** The counter BullMQ was asked for and did not return (`QueueCountersError`). */
function count(
  counts: Readonly<Record<string, number | undefined>>,
  key: string,
  queue: QueueName,
): number {
  const value = counts[key];
  if (typeof value !== "number") {
    throw new QueueCountersError(
      `queue ${queue}: bullmq returned no "${key}" counter`,
    );
  }
  return value;
}

/**
 * Queue counters for `/system/status`, over the Redis client of the api.
 *
 * The `Queue` objects come from the factory of `@sf/runtime`, opened as a
 * reader (`readOnly`): a page must not write the meta key of a queue nobody
 * has run yet, and must not wait for a client that is not ready. The factory
 * also forgets a `Queue` whose `init()` was refused, keeps one whose read
 * was refused after it got ready, and gives the reads in flight a bounded
 * moment at `close()`.
 *
 * Two decisions of the page itself:
 *
 * - **`Queue`, not a hand-written read of the keys.** The key layout is
 *   BullMQ's, and a copy of it here would drift on their next release.
 * - **`isPaused()` next to the counts.** `getJobCounts("paused")` is the
 *   length of the `paused` list, not the state of the queue: BullMQ renames
 *   `wait` to `paused` while a queue is paused, so a paused empty queue would
 *   report `paused: 0` and a paused busy one would report `waiting: 0`. The
 *   state is a flag on the queue meta, and `waiting` here is both lists.
 */
export function createQueueStats(options: QueueStatsOptions): QueueStats {
  const queues = createQueueFactory({
    connection: options.connection,
    log: options.log,
    readOnly: true,
    ...(options.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  let closed = false;

  const read = async (): Promise<QueuesSnapshot> => {
    // One round of commands over one socket, not a walk: 29 queues answered
    // in sequence would make the page as slow as the sum of the round trips.
    const rows = await Promise.all(
      QUEUE_NAMES.map(async (name): Promise<QueueStatus> => {
        const [counts, paused] = await queues.use(name, (queue) =>
          Promise.all([
            queue.getJobCounts("wait", "paused", "active", "failed", "delayed"),
            queue.isPaused(),
          ]),
        );
        return {
          name,
          // Both lists: a pause moves the backlog from one to the other, and
          // an operator asking "how much is waiting" means the same thing
          // either way.
          waiting: count(counts, "wait", name) + count(counts, "paused", name),
          active: count(counts, "active", name),
          failed: count(counts, "failed", name),
          delayed: count(counts, "delayed", name),
          paused,
        };
      }),
    );

    const dlq = rows.find((row) => row.name === DLQ_QUEUE);
    if (dlq === undefined) {
      throw new QueueCountersError(
        `queue ${DLQ_QUEUE}: missing from the counters of this pass`,
      );
    }
    const size: DlqStatus = { size: dlq.waiting };

    return { queues: rows, dlq: size };
  };

  /**
   * One pass at a time, shared by every request that arrives while it runs.
   *
   * The deadline of a request abandons a pass without cancelling it. Without
   * the sharing every request made while Redis is slow would leave 29 more
   * reads behind it; with it there is one pass in flight however often the
   * page is opened, and each request still gives up on its own deadline. The
   * pass is joined until it settles, which it does by itself: a command sent
   * is bounded by the `commandTimeout` of the client, and a reader `Queue`
   * does not wait for a client that is not ready.
   */
  const shared = singleFlight(read);

  return {
    async collect(): Promise<QueuesSnapshot> {
      if (closed) {
        throw new Error("queue stats were asked for after they were closed");
      }
      return shared();
    },

    /**
     * Stops taking requests, gives the reads already running a bounded moment
     * to finish, and then closes the queues.
     *
     * Both halves matter. Closing under a request in flight answers it with
     * "Connection is closed" - the last status page before a SIGTERM would
     * blame Redis for a shutdown of ours. Waiting for it without a bound is
     * the other failure: the stop would hang until the shutdown deadline
     * killed it, leaving Redis unclosed and the exit code at 1.
     */
    async close(): Promise<void> {
      closed = true;
      await queues.close();
    },
  };
}
