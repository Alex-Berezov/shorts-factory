import { type QueueName, isQueueName } from "@sf/core";
import { type DefaultJobOptions, type JobScheduler, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { type ClientErrors, markClientErrors } from "./client-errors.js";
import { authFailure, connectionFailure } from "./connection-failure.js";
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
 * How long an error of a `Queue` whose `init()` has no verdict yet waits for
 * one before it is written. BullMQ emits a refused `init()` as an `error` a
 * moment before the verdict reaches the factory (its own handler on the
 * promise runs first), so the listener cannot decide on the spot; a `Queue`
 * still connecting after this long is not refused, and the error is its own.
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
  /**
   * How long `close()` waits for the reads in flight, and then for the
   * queues `forget()` began to close. Overridable by tests; the default is
   * `CLOSE_DRAIN_MS`.
   */
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
  /**
   * The queue for this name, created on first use; refused after `close`.
   *
   * BullMQ connects once: `RedisConnection` starts `init()` in its
   * constructor and never again, and every command awaits that one promise. A
   * `Queue` whose `init()` was refused - Redis gone between `ready` and the
   * `INFO` of the version check, a user without the permission to run it -
   * stays broken for the life of the process, so the factory forgets it the
   * moment the refusal comes, and the next `get` builds a new one. A holder
   * of the old object keeps a broken one: whoever writes through a queue for
   * the life of the process asks for it at the moment of the write instead of
   * keeping it.
   */
  get(name: QueueName): Queue;
  /**
   * Runs `read` on the queue of this name as a read `close` waits for.
   *
   * A command refused after an `init()` that succeeded leaves the `Queue` as
   * it is: it is fine, and keeping it means a Redis that is down costs one
   * refusal per read rather than a new `Queue` per name per read. One whose
   * `init()` was refused is forgotten by the rule of `get` above, before the
   * read hears the refusal.
   */
  use<T>(name: QueueName, read: (queue: Queue) => Promise<T>): Promise<T>;
  /**
   * The one mark on the errors of the shared client (`markClientErrors`),
   * made before the first `Queue`. Whatever else is built on the client - the
   * `Worker`s of the worker - reads this one instead of a mark of its own; the
   * factory takes it off in `close()`, once nothing it built hears the client.
   */
  readonly clientErrors: ClientErrors;
  /**
   * Stops handing out queues, gives the reads in flight a bounded moment to
   * finish, closes every queue that was opened and gives those it forgot the
   * same bounded moment; the connection is not closed. A second call is the
   * same close, with the same verdict.
   */
  close(): Promise<void>;
}

/**
 * What the factory knows of the `init()` of a `Queue`: nothing yet, ready, or
 * refused with this reason.
 */
type InitVerdict = "pending" | "ready" | { refused: unknown };

/**
 * The `Queue` of the factory. Its `close()` also closes the job scheduler a
 * call of `upsertJobScheduler` or `getJobSchedulers` made: BullMQ 5.81.4
 * closes the `Repeat` of a `Queue` but not its `JobScheduler` (`queue.js`,
 * `close`), which is a `RedisConnection` of its own on the shared client -
 * its listeners stay on the client for every queue the schedules touched. The
 * field rather than the public getter: the getter builds a scheduler that was
 * never there, and waits for a client whose `init()` may have been refused.
 *
 * The getter of BullMQ sets the field only once the client is there (`await
 * this.client`), so a close during a call of the schedules finds no field
 * and the scheduler comes after it: such a late one is closed the moment it
 * comes, by the getter below.
 */
class FactoryQueue extends Queue {
  /** `close()` has begun: a job scheduler built from now on is closed at once. */
  private closeBegun = false;

  /**
   * `init()` first: the getter of BullMQ awaits the client inside an `async`
   * executor of a `new Promise`, so a refused `init()` would escape it as a
   * rejection nobody handles and leave the promise it hands out pending. Once
   * `init()` is through, the client it awaits is there.
   */
  override get jobScheduler(): Promise<JobScheduler> {
    return this.waitUntilReady()
      .then(() => super.jobScheduler)
      .then((scheduler) => {
        if (this.closeBegun) {
          // The queue is closed or closing, and nobody waits for this one: its
          // close takes its listeners off the client whatever it answers
          // (`RedisConnection.close`, `finally`), and a refusal has no one to
          // be reported to.
          void scheduler.close().catch(() => undefined);
        }
        return scheduler;
      });
  }

  /**
   * The scheduler, then the queue - the queue whichever way the scheduler
   * went. A refusal of either is the refusal of the close; of both, both, in
   * one `AggregateError`, the scheduler's first.
   */
  override async close(): Promise<void> {
    this.closeBegun = true;
    const refusals: unknown[] = [];
    if (this._jobScheduler !== undefined) {
      await this._jobScheduler.close().catch((err: unknown) => {
        refusals.push(err);
      });
    }
    await super.close().catch((err: unknown) => {
      refusals.push(err);
    });
    if (refusals.length > 1) {
      throw new AggregateError(
        refusals,
        `queue "${this.name}" and its job scheduler failed to close`,
      );
    }
    if (refusals.length === 1) {
      throw refusals[0];
    }
  }
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
 *   client emitted a moment before (`markClientErrors`) - the factory
 *   listens on the client first, which needs nothing of BullMQ but the order
 *   of the listeners;
 * - a connection failure is not either - a refused command reports it to the
 *   read that failed - and neither is a refusal of the credentials (the
 *   client says it) or a refused `init()` of any kind, which has a line of
 *   its own below, or none;
 * - any other error of a `Queue` is a defect nobody else would see, and is
 *   written - unless the factory is closed by the time it would be.
 *
 * The verdict on `init()` is taken once per `Queue`, by one handler on
 * `waitUntilReady()` put there when the `Queue` is built: a Redis that is down
 * leaves that promise pending for as long as it is down, and a handler per
 * error would pile up on it. A refused `init()` makes the factory forget the
 * `Queue` (see `get`). A writer refused by Redis itself - not by a connection
 * failure, not over the credentials - is a defect of the setup nothing else
 * reports (a permission the user lacks, a Redis too old), and gets one
 * `queue init refused` line per queue name for the life of the factory: the
 * next `get` of the name builds a new `Queue` refused the same way, and the
 * switch resync of the worker asks for every name on each pass
 * (docs/DECISIONS.md, Р1 E0-12R and its clarifications of 22.10.2026). A reader
 * writes none: every read of it is refused with the reason and reports it.
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
  const verdicts = new WeakMap<Queue, InitVerdict>();
  /**
   * The names whose refused `init()` was already written: one line per name
   * for the life of the factory.
   */
  const refusalWritten = new Set<QueueName>();
  const inFlight = new Set<Promise<unknown>>();
  const drainTimeoutMs = options.drainTimeoutMs ?? CLOSE_DRAIN_MS;
  let closed = false;
  let closing: Promise<void> | undefined;
  /**
   * The errors the shared client emitted. Registered before any `Queue`
   * exists, so this listener runs ahead of the one each `Queue` puts on the
   * client, and the copy the `Queue` hears is already marked.
   */
  const clientErrors = markClientErrors(options.connection);

  /**
   * The closes `forget()` started and nobody waited for yet. Not waited for
   * there - the refusal is news at once - but by `close()`: such a `Queue`
   * still hears the client while it closes, and the stage after the factory
   * tears that client down.
   */
  const forgotten = new Set<Promise<void>>();

  const forget = (name: QueueName, queue: Queue): void => {
    if (cache.get(name) !== queue) {
      return;
    }
    cache.delete(name);
    const forgetting = queue.close().then(
      () => undefined,
      () => {
        // A close that failed is a `Queue` nobody holds a reference to any
        // more; the refused `init()` is the news, not this.
      },
    );
    forgotten.add(forgetting);
    void forgetting.then(() => forgotten.delete(forgetting));
  };

  /** Takes the verdict on `init()` once, when the `Queue` is built. */
  const awaitVerdict = (name: QueueName, queue: Queue): void => {
    verdicts.set(queue, "pending");
    queue.waitUntilReady().then(
      () => {
        verdicts.set(queue, "ready");
      },
      (reason: unknown) => {
        verdicts.set(queue, { refused: reason });
        if (
          !options.readOnly &&
          !closed &&
          cache.get(name) === queue &&
          connectionFailure(reason) === undefined &&
          !authFailure(reason) &&
          !refusalWritten.has(name)
        ) {
          refusalWritten.add(name);
          // Before `forget`, whose close may say more about the same `Queue`.
          options.log.error({ queue: name, err: reason }, "queue init refused");
        }
        forget(name, queue);
      },
    );
  };

  /** Writes an error of a `Queue`, unless it is its refused `init()`. */
  const writeQueueError = (name: QueueName, queue: Queue, err: Error): void => {
    // Read when the line would be written, not when the error came: the
    // verdict may have taken `INIT_VERDICT_MS`, and the factory may be closed
    // by then - a line after the stop is a line about nothing.
    if (closed) {
      return;
    }
    const verdict = verdicts.get(queue);
    if (typeof verdict === "object" && verdict.refused === err) {
      return;
    }
    options.log.error({ queue: name, err }, "queue error");
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
    const queue = new FactoryQueue(name, {
      connection: options.connection,
      ...(options.readOnly
        ? { skipMetasUpdate: true, skipWaitingForReady: true }
        : { defaultJobOptions: options.defaultJobOptions }),
    });
    queue.on("error", (err: Error) => {
      if (clientErrors.writtenByClient(err)) {
        return;
      }
      // BullMQ emits a refused `init()` here as well, on every `Queue` it
      // refused, ahead of the verdict: a verdict that is in decides now, one
      // that is not is read once more after `INIT_VERDICT_MS` - a timer, not
      // one more handler on a promise that may never settle.
      if (verdicts.get(queue) !== "pending") {
        writeQueueError(name, queue, err);
        return;
      }
      // Not holding the loop open: a line is no reason to keep a process up.
      setTimeout(() => {
        writeQueueError(name, queue, err);
      }, INIT_VERDICT_MS).unref();
    });
    cache.set(name, queue);
    awaitVerdict(name, queue);
    return queue;
  };

  const closeOnce = async (): Promise<void> => {
    closed = true;
    try {
      if (inFlight.size > 0) {
        const reads = [...inFlight];
        // Not holding the loop open: it bounds a shutdown, and a live timer
        // would keep the process up longer than the sequence ending it.
        await settleWithin(
          () => Promise.allSettled(reads),
          drainTimeoutMs,
          undefined,
          { unref: true },
        );
      }
      const queues = [...cache.values()];
      cache.clear();
      // Every queue is waited for, whichever of them refuses, and so is
      // every close `forget()` started: the stage after this one tears the
      // client down, and a `Queue` still closing on it would lose its socket
      // mid-close. The forgotten ones are waited for apart from the cached
      // ones: their closes never reject (`forget()` caught them), so only the
      // cached ones can be refusals to report; and they are bounded here,
      // because a `Queue` refused its `init()` is the one whose close is
      // least to be trusted - unbounded it would hold the stop until its
      // deadline. A cached one is bounded by that deadline, like every stage.
      // The set of forgotten ones is complete when it is read: `forget()`
      // acts only on a `Queue` still in the cache, emptied above, so a verdict
      // that comes during the close finds its `Queue` among those closed here.
      const [outcomes] = await Promise.all([
        Promise.allSettled(queues.map((queue) => queue.close())),
        settleWithin(
          () => Promise.allSettled([...forgotten]),
          drainTimeoutMs,
          undefined,
          { unref: true },
        ),
      ]);
      const refusals = outcomes.flatMap((outcome) =>
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
      clientErrors.dispose();
    }
  };

  return {
    get,
    clientErrors,

    async use<T>(
      name: QueueName,
      read: (queue: Queue) => Promise<T>,
    ): Promise<T> {
      const pass = read(get(name));
      inFlight.add(pass);
      try {
        return await pass;
      } finally {
        inFlight.delete(pass);
      }
    },

    close(): Promise<void> {
      // One close, however many callers: a second pass would take the mark
      // off twice and close queues that are already closing. A second caller
      // gets the same verdict, a refusal included.
      closing ??= closeOnce();
      return closing;
    },
  };
}
