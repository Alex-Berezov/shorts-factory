import type { DlqStatus, QueueStatus } from "@sf/contracts";
import { QUEUE_NAMES, type QueueName } from "@sf/core";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { QueueStatsProbe, QueuesSnapshot } from "../deps.js";
import { singleFlight } from "./single-flight.js";

/** The queue whose depth is the DLQ size; it has no processor of its own. */
const DLQ_QUEUE: QueueName = "system.dlq";

/**
 * How long `close()` waits for the passes that are still reading.
 *
 * Bounded, because nothing ends such a pass from here: the deadline of a
 * request gives up on it without stopping it. A pass does end by itself -
 * every command it sends is bounded by the `commandTimeout` of the client
 * (`lib/redis.ts`), and a `Queue` refuses at once instead of waiting for a
 * client that is not ready (`skipWaitingForReady` below) - but the close of a
 * service on its way out has no reason to wait for that. An unbounded wait
 * here would also be one more place where a pass that hangs in some way not
 * foreseen holds the whole shutdown until its own ten-second deadline fired,
 * leaving Redis unclosed and the process leaving with code 1 after a clean
 * SIGTERM (`lib/shutdown.ts`). A read abandoned this way answers its request
 * with a connection error, which is the truth about a service on its way out.
 */
const CLOSE_DRAIN_MS = 2_000;

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
  /** Overridable by tests; the default is `CLOSE_DRAIN_MS`. */
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
 * Waits for the passes that are still reading, and gives up after `timeoutMs`.
 *
 * The timer is unreferenced: it exists to bound a shutdown, and a live one
 * would be a reason for the process to stay up a second longer than the
 * sequence that is trying to end it.
 */
async function drain(
  passes: ReadonlyArray<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  if (passes.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([Promise.allSettled(passes), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queue counters for `/system/status`, over the Redis client of the api.
 *
 * Four decisions worth keeping:
 *
 * - **`Queue`, not a hand-written read of the keys.** The key layout is
 *   BullMQ's, and a copy of it here would drift on their next release.
 * - **`skipMetasUpdate: true`.** Without it the constructor writes:
 *   `waitUntilReady` does `HSET bull:<name>:meta` with the version and
 *   `opts.maxLenEvents` of whoever opened the queue. Opening a status page
 *   would then create meta keys for queues nobody has run yet and reset the
 *   event stream bound the worker configured. A page is a reader (ADR-0003).
 * - **An `error` listener per `Queue`.** ioredis reports connection failures
 *   as events; an `EventEmitter` error with no listener ends the process. With
 *   29 queues, a Redis outage without this is 29 ways to take the api down at
 *   exactly the moment its status page is being opened.
 * - **`skipWaitingForReady: true`.** Without it every command of a `Queue`
 *   opened while the client is not `ready` waits in `waitUntilReady` for a
 *   `ready` or an `end` (bullmq `redis-connection.js`), and with the
 *   `retryStrategy` of `lib/redis.ts` a client that cannot reach Redis
 *   reconnects forever and reaches neither - no `commandTimeout` applies to a
 *   command that was never sent. With it the `INFO` of the version check goes
 *   to the client at once and is refused the way every command of the api
 *   is while the socket is down ("Stream isn't writeable...", `unreachable`),
 *   and the failed `Queue` is thrown away by `forget`.
 * - **`isPaused()` next to the counts.** `getJobCounts("paused")` is the
 *   length of the `paused` list, not the state of the queue: BullMQ renames
 *   `wait` to `paused` while a queue is paused, so a paused empty queue would
 *   report `paused: 0` and a paused busy one would report `waiting: 0`. The
 *   state is a flag on the queue meta, and `waiting` here is both lists.
 *
 * The client of the api (`lib/redis.ts`) is fine for this: BullMQ only demands
 * `maxRetriesPerRequest: null` for the blocking connections of a `Worker`, and
 * a status page wants the opposite - a fast refusal while Redis is down.
 */
export function createQueueStats(options: QueueStatsOptions): QueueStats {
  const queues = new Map<QueueName, Queue>();
  /**
   * The pass still reading, for `close` to wait for. One at most: every
   * request joins the pass in flight (`shared` below) until it settles.
   */
  let inFlight: Promise<unknown> | undefined;
  let closed = false;

  const queueFor = (name: QueueName): Queue => {
    const existing = queues.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const queue = new Queue(name, {
      connection: options.connection,
      // Read-only: see the docblock above before removing this.
      skipMetasUpdate: true,
      // Refuse at once on a client that is not ready: see the docblock above.
      skipWaitingForReady: true,
    });
    // Listened to, not written: the client writes its own failure
    // (`createRedis`), and a refused `init()` is the failure of the pass,
    // which its answer reports. A line here would be 29 per poll.
    queue.on("error", () => {});
    queues.set(name, queue);
    return queue;
  };

  /**
   * Drops a `Queue` that failed, so that the next request builds a new one.
   *
   * BullMQ connects once: `RedisConnection` assigns `this.initializing =
   * this.init()` in its constructor and never calls it again, and every
   * command awaits that one promise. A `Queue` whose `init()` rejected - Redis
   * gone between `ready` and the `INFO` behind the version check, or a command
   * flushed by `MaxRetriesPerRequestError` - therefore stays broken for the
   * life of the process: `queues` and `dlq` would keep reading `null` and
   * `checks.redis` `down` long after Redis came back, until someone restarted
   * the api. Closing it here only detaches the listeners, since the connection
   * is the shared client of the api and BullMQ does not touch a client it was
   * handed.
   */
  const forget = (name: QueueName, queue: Queue): void => {
    if (queues.get(name) !== queue) {
      return;
    }
    queues.delete(name);
    void queue.close().catch(() => {
      // A close that failed is a `Queue` nobody holds a reference to any more;
      // the request that just failed is the news, not this.
    });
  };

  const read = async (): Promise<QueuesSnapshot> => {
    // One round of commands over one socket, not a walk: 29 queues answered
    // in sequence would make the page as slow as the sum of the round trips.
    const rows = await Promise.all(
      QUEUE_NAMES.map(async (name): Promise<QueueStatus> => {
        const queue = queueFor(name);
        const [counts, paused] = await Promise.all([
          queue.getJobCounts("wait", "paused", "active", "failed", "delayed"),
          queue.isPaused(),
        ]).catch((err: unknown) => {
          forget(name, queue);
          throw err;
        });
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
   * The deadline of a request abandons a pass without cancelling it
   * (`CLOSE_DRAIN_MS`). Without the sharing every request made while Redis
   * is slow would leave 29 more reads behind it; with it there is one pass in
   * flight however often the page is opened, and each request still gives up
   * on its own deadline. The pass is joined until it settles, which it does
   * by itself: a command sent is bounded by the `commandTimeout` of the
   * client, and a `Queue` does not wait for a client that is not ready
   * (`skipWaitingForReady`).
   */
  const shared = singleFlight(async (): Promise<QueuesSnapshot> => {
    const pass = read();
    inFlight = pass;
    try {
      return await pass;
    } finally {
      inFlight = undefined;
    }
  });

  return {
    async collect(): Promise<QueuesSnapshot> {
      if (closed) {
        throw new Error("queue stats were asked for after they were closed");
      }
      return shared();
    },

    /**
     * Stops taking requests, gives the ones already reading a bounded moment
     * to finish, and then closes the queues.
     *
     * Both halves matter. Closing under a request in flight answers it with
     * "Connection is closed" - the last status page before a SIGTERM would
     * blame Redis for a shutdown of ours. Waiting for it without a bound is
     * the other failure: a read issued while Redis is unreachable is refused
     * at once (`skipWaitingForReady`); the bound is for a pass that hangs in a
     * way not foreseen (`CLOSE_DRAIN_MS`), and without it the stop would then
     * hang until the shutdown deadline killed it.
     */
    async close(): Promise<void> {
      closed = true;
      await drain(
        inFlight === undefined ? [] : [inFlight],
        options.drainTimeoutMs ?? CLOSE_DRAIN_MS,
      );
      const open = [...queues.values()];
      queues.clear();
      await Promise.all(open.map((queue) => queue.close()));
    },
  };
}
