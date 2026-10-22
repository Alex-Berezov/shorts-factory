import { QUEUE_NAMES } from "@sf/core";
import { silentLogger } from "@sf/runtime/test-support/recording-logger";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueueCountersError,
  createQueueStats,
} from "../src/lib/queue-stats.js";

/**
 * The queue reader without Redis: what is asserted here is what the api does
 * to the queues it reads, and that is decided by the options it constructs
 * them with and by what it does with an answer it did not expect.
 */

/** Options every `Queue` in a test was constructed with, in order. */
const constructed: Array<{ name: string; options: unknown }> = [];

/** What the fake queues answer; a test replaces either of them. */
let counts: Record<string, number> = {
  wait: 1,
  paused: 2,
  active: 3,
  failed: 4,
  delayed: 5,
};
let beforeCounts: () => Promise<void> = async () => {};
/** What `init()` of a `Queue` built from now on settled with; ready if unset. */
let initRefusal: Error | undefined;
const closedQueues: string[] = [];

vi.mock("bullmq", () => {
  class FakeQueue {
    readonly name: string;
    private readonly refusal: Error | undefined;
    constructor(name: string, options: unknown) {
      this.name = name;
      this.refusal = initRefusal;
      constructed.push({ name, options });
    }
    async waitUntilReady(): Promise<void> {
      if (this.refusal !== undefined) {
        throw this.refusal;
      }
    }
    on(): this {
      return this;
    }
    async getJobCounts(): Promise<Record<string, number>> {
      await beforeCounts();
      return counts;
    }
    async isPaused(): Promise<boolean> {
      return false;
    }
    async close(): Promise<void> {
      closedQueues.push(this.name);
    }
  }
  return { Queue: FakeQueue };
});

/**
 * The client the fake queues are handed and never use.
 *
 * A real one rather than a cast: `Redis` is a type nobody can write out
 * honestly by hand, and `{} as Redis` is the same hole in the typing whichever
 * spelling it takes (`apps/worker/test/job-deps.ts` says the same). It opens
 * no socket - `lazyConnect` connects on the first command - so a code path
 * that did reach past the fake would fail loudly instead of reading an answer
 * that was never given.
 */
const connection = new Redis({ lazyConnect: true, port: 6399 });

beforeEach(() => {
  constructed.length = 0;
  closedQueues.length = 0;
  counts = { wait: 1, paused: 2, active: 3, failed: 4, delayed: 5 };
  beforeCounts = async () => {};
  initRefusal = undefined;
});

/** What the page writes about the queues is not under test here. */
const log = silentLogger();

afterEach(() => {
  vi.useRealTimers();
});

/** Closes the stats under fake timers: the drain of a hung pass is a timer. */
async function closeAfterDrain(
  stats: { close(): Promise<void> },
  drainTimeoutMs: number,
): Promise<void> {
  const closing = stats.close();
  await vi.advanceTimersByTimeAsync(drainTimeoutMs);
  await closing;
}

describe("createQueueStats", () => {
  /**
   * The page is a reader. Without `skipMetasUpdate` the constructor of a
   * `Queue` writes `bull:<name>:meta` on its way to ready - creating meta keys
   * for queues nobody has run yet and overwriting the event stream bound the
   * worker set.
   */
  it("opens every queue without letting it write the meta key", async () => {
    const stats = createQueueStats({ connection, log });

    await stats.collect();

    expect(constructed).toHaveLength(QUEUE_NAMES.length);
    for (const queue of constructed) {
      expect(queue.options).toMatchObject({ skipMetasUpdate: true });
    }
  });

  it("reports the counters and the depth of the dlq", async () => {
    const stats = createQueueStats({ connection, log });

    const snapshot = await stats.collect();

    expect(snapshot.queues).toHaveLength(QUEUE_NAMES.length);
    expect(snapshot.queues[0]).toEqual({
      name: QUEUE_NAMES[0],
      waiting: 3,
      active: 3,
      failed: 4,
      delayed: 5,
      paused: false,
    });
    expect(snapshot.dlq).toEqual({ size: 3 });
  });

  /**
   * A counter that is not in the answer is not a counter that is zero: filling
   * it in would put "nothing waiting" on the page of an operator who came to
   * find out why nothing is moving.
   */
  it("refuses to invent a counter bullmq did not return", async () => {
    counts = { wait: 1, paused: 2, active: 3, failed: 4 };
    const stats = createQueueStats({ connection, log });

    await expect(stats.collect()).rejects.toBeInstanceOf(QueueCountersError);
  });

  /**
   * The last page before a SIGTERM: closing the queues under a request that is
   * already reading answers it with "Connection is closed", which the page
   * would report as a Redis that is unreachable - a lie about the dependency
   * on the way out.
   */
  it("lets a request that is already reading finish before it closes", async () => {
    // One gate for all 29 queues: a promise per call would leave the other
    // twenty-eight hanging and the test would prove nothing about the close.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeCounts = () => gate;
    const stats = createQueueStats({ connection, log });

    const pending = stats.collect();
    const closing = stats.close();
    expect(closedQueues).toHaveLength(0);
    release();

    await expect(pending).resolves.toMatchObject({ dlq: { size: 3 } });
    await closing;
    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);
  });

  /**
   * A read of a Redis that is gone does not settle: the client of the api
   * keeps reconnecting, and `withDeadline` in front of the request abandons
   * the pass without cancelling it. Waiting for that pass without a bound is
   * the api hanging on SIGTERM until the shutdown deadline kills it, leaving
   * Redis unclosed and the exit code at 1.
   */
  it("stops waiting for a pass that never answers and closes anyway", async () => {
    vi.useFakeTimers();
    beforeCounts = () => new Promise<void>(() => {});
    const stats = createQueueStats({ connection, log, drainTimeoutMs: 20 });
    // Nobody is ever going to await this one; it is the request Redis ate.
    void stats.collect().catch(() => {});
    // Let the pass reach the fake queues before the close begins.
    await vi.advanceTimersByTimeAsync(0);

    await closeAfterDrain(stats, 20);

    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);
  });

  /**
   * A Redis that hangs: every pass waits forever, and a request gives up on
   * its own deadline without cancelling the pass behind it. Requests that
   * arrive meanwhile must join that pass rather than leave 29 more reads each
   * on the same silent socket.
   */
  it("shares one pass between the requests that arrive while it reads", async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<void>(() => {}));
    beforeCounts = hung;
    const stats = createQueueStats({ connection, log, drainTimeoutMs: 20 });

    const requests = Array.from({ length: 5 }, () => stats.collect());
    for (const request of requests) {
      // Nobody awaits these; they are the requests Redis ate.
      void request.catch(() => {});
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(hung).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    await closeAfterDrain(stats, 20);
  });

  /**
   * Requests that each gave up on a pass that hangs - minutes apart, as a
   * page polled every 15 seconds does - leave that one pass behind them, not
   * one each; once it settles, the next request reads again.
   */
  it("keeps one pass however many requests give up on it", async () => {
    vi.useFakeTimers();
    const answers: Array<() => void> = [];
    const held = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    beforeCounts = held;
    const stats = createQueueStats({ connection, log, drainTimeoutMs: 20 });

    for (let poll = 0; poll < 3; poll += 1) {
      // Nobody awaits these; they are the requests that gave up.
      void stats.collect().catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(held).toHaveBeenCalledTimes(QUEUE_NAMES.length);

    // Redis answers at last: the pass settles, and the next request reads.
    for (const answer of answers) {
      answer();
    }
    await vi.advanceTimersByTimeAsync(0);
    beforeCounts = async () => {};
    await expect(stats.collect()).resolves.toMatchObject({ dlq: { size: 3 } });
    await closeAfterDrain(stats, 20);
  });

  it("starts a new pass for a request that arrives after the last one answered", async () => {
    const reads = vi.fn(async () => {});
    beforeCounts = reads;
    const stats = createQueueStats({ connection, log });

    await stats.collect();
    await stats.collect();

    // Nothing is cached: the second request asks Redis again.
    expect(reads).toHaveBeenCalledTimes(QUEUE_NAMES.length * 2);
    await stats.close();
  });

  /**
   * BullMQ connects once - `initializing` is assigned in the constructor and
   * never retried - so a `Queue` whose init rejected answers every later call
   * with the same rejection. Kept in the map, it would leave the page showing
   * `redis: down` long after Redis came back, until someone restarted the api.
   */
  it("throws away a queue whose init was refused so the next request rebuilds it", async () => {
    const stats = createQueueStats({ connection, log });
    initRefusal = new Error("Connection is closed.");
    beforeCounts = async () => {
      throw new Error("Connection is closed.");
    };

    await expect(stats.collect()).rejects.toThrow(/Connection is closed/);
    expect(constructed).toHaveLength(QUEUE_NAMES.length);
    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);

    // Redis is back; the next request must not inherit the broken objects.
    initRefusal = undefined;
    beforeCounts = async () => {};
    await expect(stats.collect()).resolves.toMatchObject({ dlq: { size: 3 } });
    expect(constructed).toHaveLength(QUEUE_NAMES.length * 2);

    await stats.close();
  });

  /**
   * A command refused after the `Queue` got ready is not a broken `Queue`:
   * rebuilt on every poll during an outage, it would be 29 new objects and
   * their listeners per request (docs/TECH_DEBT.md, E0-09).
   */
  it("keeps a queue whose read was refused after it got ready", async () => {
    const stats = createQueueStats({ connection, log });
    beforeCounts = async () => {
      throw new Error("Connection is closed.");
    };

    await expect(stats.collect()).rejects.toThrow(/Connection is closed/);
    beforeCounts = async () => {};
    await expect(stats.collect()).resolves.toMatchObject({ dlq: { size: 3 } });

    expect(constructed).toHaveLength(QUEUE_NAMES.length);
    expect(closedQueues).toHaveLength(0);
    await stats.close();
  });

  /**
   * The sharing ends on the first line of the close: a request made while the
   * close waits for the pass in flight starts its own and gets the refusal of
   * the factory, while the request joined before the close still gets the
   * answer of its pass.
   */
  it("refuses a request during the close while a pass is in flight; the pass already joined still answers", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = vi.fn(() => gate);
    beforeCounts = reads;
    const stats = createQueueStats({ connection, log });

    const pending = stats.collect();
    const closing = stats.close();
    const late = stats.collect();

    await expect(late).rejects.toThrow(/after the queue factory was closed/);
    release();
    await expect(pending).resolves.toMatchObject({ dlq: { size: 3 } });
    await closing;
    expect(reads).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);
  });

  /**
   * With no pass to join the request starts one of its own, and the factory -
   * closed from the first line of its close - refuses it, with its own text:
   * there is no second state of the close here to answer first.
   */
  it("refuses a request during the close when no pass is in flight, through the factory", async () => {
    const reads = vi.fn(async () => {});
    beforeCounts = reads;
    const stats = createQueueStats({ connection, log });

    const closing = stats.close();
    const late = stats.collect();

    await expect(late).rejects.toThrow(/after the queue factory was closed/);
    await closing;
    expect(reads).not.toHaveBeenCalled();
  });

  /**
   * The edge of the drain: a pass that outlives `drainTimeoutMs` is not waited
   * for. The queues close under it, and the request joined to it before the
   * close is left to that pass - the close neither answers nor refuses it.
   */
  it("closes under a pass longer than the drain and leaves the request joined to it before the close unanswered", async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<void>(() => {}));
    beforeCounts = hung;
    const stats = createQueueStats({ connection, log, drainTimeoutMs: 20 });
    let settled = false;
    const mark = (): void => {
      settled = true;
    };

    stats.collect().then(mark, mark);
    await vi.advanceTimersByTimeAsync(0);
    const closing = stats.close();
    await vi.advanceTimersByTimeAsync(20);
    await closing;

    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);
    expect(hung).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
  });

  /**
   * A pass the close did not wait for may hang on after it: a request made
   * once the close is over must not join it - the stage after this one closes
   * the client under it, and the page would blame Redis - but get the refusal
   * of the factory.
   */
  it("refuses a request after a close that outlived a pass, instead of joining that pass", async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<void>(() => {}));
    beforeCounts = hung;
    const stats = createQueueStats({ connection, log, drainTimeoutMs: 20 });

    void stats.collect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const closing = stats.close();
    await vi.advanceTimersByTimeAsync(20);
    await closing;

    await expect(stats.collect()).rejects.toThrow(
      /after the queue factory was closed/,
    );
    expect(hung).toHaveBeenCalledTimes(QUEUE_NAMES.length);
  });

  it("refuses a request that arrives after the close", async () => {
    const stats = createQueueStats({ connection, log });
    await stats.close();

    await expect(stats.collect()).rejects.toThrow(
      /after the queue factory was closed/,
    );
  });
});
