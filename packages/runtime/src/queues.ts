import { type QueueName, isQueueName } from "@sf/core";
import { type DefaultJobOptions, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { connectionFailure } from "./connection-failure.js";
import { settleWithin } from "./deadline.js";
import type { RuntimeLogger } from "./runtime-logger.js";

/**
 * How long `close()` waits for the reads still in flight.
 *
 * Bounded, because nothing ends such a read from here: the deadline of a
 * request gives up on it without stopping it. A read does end by itself on the
 * client of requests - every command is bounded by its `commandTimeout`, and a
 * read-only `Queue` refuses at once on a client that is not ready - but the
 * close of a process on its way out has no reason to wait for that, and an
 * unbounded wait would be one more place where a read that hangs in some way
 * not foreseen holds the whole shutdown until its own deadline.
 */
const CLOSE_DRAIN_MS = 2_000;

/**
 * How long a failed read waits to learn whether the `init()` of its `Queue`
 * was refused. A read that reached a command has a settled `init()` already
 * and learns it within microtasks; the bound is for a failure that never got
 * that far, on a `Queue` still connecting, which is kept.
 */
const INIT_VERDICT_MS = 50;

/** What every factory is given, whichever way it opens its queues. */
interface CommonFactoryOptions {
  /**
   * Shared, not owned: BullMQ does not close a client it was handed
   * (`RedisConnection` treats an instance as shared), so the composition root
   * closes it once, after the factory.
   */
  connection: Redis;
  /** Where an error of a `Queue` that is not a connection failure is written. */
  log: RuntimeLogger;
  /** Overridable by tests; the default is `CLOSE_DRAIN_MS`. */
  drainTimeoutMs?: number;
}

/**
 * A writer: a job added through these queues gets `defaultJobOptions` unless
 * it says otherwise. Required, so that a process that adds jobs cannot open
 * its queues without the retry policy - attempts, backoff and the bounds of
 * the kept records are the worker's (`lib/job-policy.ts`) and stay there; the
 * factory only carries them.
 */
interface WriterFactoryOptions extends CommonFactoryOptions {
  readOnly: false;
  defaultJobOptions: DefaultJobOptions;
}

/**
 * A reader - the status page of the api - opens every queue without letting
 * it write and without waiting for a client that is not ready, and adds no
 * jobs, so it has no job options to pass:
 *
 * - `skipMetasUpdate`: without it the constructor writes on its way to
 *   ready (`HSET bull:<name>:meta` with the version and `maxLenEvents` of
 *   whoever opened the queue), creating meta keys for queues nobody has run
 *   yet and resetting the event stream bound the worker set (ADR-0003);
 * - `skipWaitingForReady`: without it every command of a `Queue` opened
 *   while the client is not `ready` waits for a `ready` or an `end`, and a
 *   client that reconnects forever reaches neither - no `commandTimeout`
 *   applies to a command that was never sent. With it the `INFO` of the
 *   version check goes to the client at once and is refused the way every
 *   command of a fail-fast client is while the socket is down.
 */
interface ReaderFactoryOptions extends CommonFactoryOptions {
  readOnly: true;
  defaultJobOptions?: never;
}

type QueueFactoryOptions = WriterFactoryOptions | ReaderFactoryOptions;

/**
 * Lazy `Queue` per name, with a cache.
 *
 * Lazy in the sense that nothing is created for a name nobody asks for - not
 * in the sense that a boot is cheap: the worker asks for every name of the
 * registry while it starts. Cached because two `Queue` objects for one name
 * are two sets of listeners and two things to close, and a job added through
 * the second one would carry different default options.
 */
export interface QueueFactory {
  /** The queue for this name, created on first use; refused after `close`. */
  get(name: QueueName): Queue;
  /**
   * Runs `read` on the queue of this name as a read `close` waits for, and
   * throws the `Queue` away when its failure was a refused `init()`.
   *
   * BullMQ connects once: `RedisConnection` starts `init()` in its
   * constructor and never again, and every command awaits that one promise. A
   * `Queue` whose `init()` was refused - Redis gone between `ready` and the
   * `INFO` of the version check - stays broken for the life of the process,
   * so it is forgotten and the next read builds a new one. A command refused
   * after an `init()` that succeeded is not that: the `Queue` is fine, and
   * keeping it means a Redis that is down costs one refusal per read rather
   * than a new `Queue` per name per read.
   */
  use<T>(name: QueueName, read: (queue: Queue) => Promise<T>): Promise<T>;
  /**
   * Stops handing out queues, gives the reads in flight a bounded moment to
   * finish and closes every queue that was opened; the connection is not
   * closed.
   */
  close(): Promise<void>;
}

/** A refused `init()`, with what it was refused with. */
interface InitRefusal {
  reason: unknown;
}

/**
 * The verdict on the `init()` of a `Queue`, through `waitUntilReady()` - the
 * public face of the one promise every command awaits. A refusal only; a
 * `Queue` that got ready, or is still connecting after `INIT_VERDICT_MS`, has
 * none.
 */
async function initRefusal(queue: Queue): Promise<InitRefusal | undefined> {
  return settleWithin(
    () =>
      queue.waitUntilReady().then(
        (): InitRefusal | undefined => undefined,
        (reason: unknown): InitRefusal => ({ reason }),
      ),
    INIT_VERDICT_MS,
    undefined,
    { unref: true },
  );
}

/**
 * The factory every process opens its queues through.
 *
 * Every `Queue` gets an `error` listener: ioredis reports connection failures
 * as events, an `EventEmitter` error with no listener ends the process, and a
 * Redis outage is 29 of them at once. What is written is only what nobody
 * else writes:
 *
 * - an error of the shared client is not: BullMQ hands every error of the
 *   client it runs on to every `Queue` on it (`RedisConnection` re-emits the
 *   `error` of the client), and the client reports its own at a level that
 *   fades. A wrong password or a name Docker cannot resolve yet would
 *   otherwise be one `error` line per queue per reconnect, with nothing to
 *   tell them apart. Such an error is recognised as the very object the
 *   client emitted a moment before - the factory listens on the client
 *   first, which needs nothing of BullMQ but the order of the listeners;
 * - a connection failure is not either - a refused command reports it to the
 *   read that failed - and neither is a refused `init()` of any kind: every
 *   read of that `Queue` is refused with it;
 * - any other error of a `Queue` is a defect nobody else would see, and is
 *   written.
 *
 * There is no guard on the state of the client (decision of 11.10.2026,
 * E0-11B round 3): a pass over the queues while Redis is down builds a
 * `Queue` for every name that has none which ever got ready - each of them
 * refused and forgotten, the next pass the same - so a process that starts
 * during the outage pays that on every pass until Redis is back. A `Queue`
 * whose `init()` succeeded before the outage is kept through it.
 */
export function createQueueFactory(options: QueueFactoryOptions): QueueFactory {
  const cache = new Map<QueueName, Queue>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  /**
   * The errors the shared client emitted. Registered before any `Queue`
   * exists, so this listener runs ahead of the one each `Queue` puts on the
   * client, and the copy the `Queue` hears is already marked.
   */
  const fromClient = new WeakSet<object>();
  const markClientError = (err: unknown): void => {
    if (typeof err === "object" && err !== null) {
      fromClient.add(err);
    }
  };
  options.connection.on("error", markClientError);

  /**
   * The closes `forget()` started and nobody waited for yet. Not waited for
   * there - the read that failed answers at once - but by `close()`: such a
   * `Queue` still hears the client while it closes, and the stage after the
   * factory tears that client down.
   */
  const forgotten = new Set<Promise<void>>();

  const forget = (name: QueueName, queue: Queue): void => {
    if (cache.get(name) !== queue) {
      return;
    }
    cache.delete(name);
    const closing = queue.close().then(
      () => undefined,
      () => {
        // A close that failed is a `Queue` nobody holds a reference to any
        // more; the read that just failed is the news, not this.
      },
    );
    forgotten.add(closing);
    void closing.then(() => forgotten.delete(closing));
  };

  const get = (name: QueueName): Queue => {
    // Refused once the factory is closed rather than quietly opening one
    // more: the cache is empty by then, so a latecomer (a switch resync that
    // was still running, a listener firing during the stop) would get a brand
    // new `Queue` with a set of listeners nobody is going to close, and the
    // process would hang until the shutdown deadline.
    if (closed) {
      throw new Error(
        `queue "${name}" requested after the queue factory was closed`,
      );
    }
    const existing = cache.get(name);
    if (existing !== undefined) {
      return existing;
    }
    // A name that is not in the registry cannot be typed away when it comes
    // from stored data (`app_setting`, a DLQ record of a renamed queue).
    if (!isQueueName(name)) {
      throw new Error(`unknown queue "${name}": not in QUEUE_NAMES`);
    }
    const queue = new Queue(name, {
      connection: options.connection,
      ...(options.readOnly
        ? { skipMetasUpdate: true, skipWaitingForReady: true }
        : { defaultJobOptions: options.defaultJobOptions }),
    });
    queue.on("error", (err: Error) => {
      if (fromClient.has(err) || connectionFailure(err) !== undefined) {
        return;
      }
      // BullMQ emits a refused `init()` here as well, on every `Queue` it
      // refused - a permission the user of the client lacks, a Redis too old.
      // That refusal is the answer of every read of the `Queue`, which reports
      // it; written here too it would be one line per queue per pass. It is
      // recognised as the very value `waitUntilReady()` is refused with.
      void initRefusal(queue).then((refusal) => {
        if (refusal?.reason === err) {
          return;
        }
        options.log.error({ queue: name, err }, "queue error");
      });
    });
    cache.set(name, queue);
    return queue;
  };

  return {
    get,

    async use<T>(
      name: QueueName,
      read: (queue: Queue) => Promise<T>,
    ): Promise<T> {
      const queue = get(name);
      const pass = (async (): Promise<T> => {
        try {
          return await read(queue);
        } catch (err) {
          if ((await initRefusal(queue)) !== undefined) {
            forget(name, queue);
          }
          throw err;
        }
      })();
      inFlight.add(pass);
      try {
        return await pass;
      } finally {
        inFlight.delete(pass);
      }
    },

    async close(): Promise<void> {
      closed = true;
      try {
        if (inFlight.size > 0) {
          const reads = [...inFlight];
          // Not holding the loop open: it bounds a shutdown, and a live timer
          // would keep the process up longer than the sequence ending it.
          await settleWithin(
            () => Promise.allSettled(reads),
            options.drainTimeoutMs ?? CLOSE_DRAIN_MS,
            undefined,
            { unref: true },
          );
        }
        const queues = [...cache.values()];
        cache.clear();
        // Every queue is waited for, whichever of them refuses, and so is
        // every close `forget()` started: the stage after this one tears the
        // client down, and a `Queue` still closing on it would lose its socket
        // mid-close. Only the refusals of the cached ones are reported; a
        // forgotten one was given up on when its read failed.
        const closing = queues.map((queue) => queue.close());
        const outcomes = await Promise.allSettled([...closing, ...forgotten]);
        const refusals = outcomes
          .slice(0, closing.length)
          .flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
        if (refusals.length > 0) {
          throw new AggregateError(
            refusals,
            `${refusals.length} of ${queues.length} queues failed to close`,
          );
        }
      } finally {
        // Only now, after the forgotten ones too: a `Queue` still closing
        // hears the client as well.
        options.connection.off("error", markClientError);
      }
    },
  };
}
