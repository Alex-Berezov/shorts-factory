import { QUEUE_NAMES } from "@sf/core";
import { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const closedQueues: string[] = [];

vi.mock("bullmq", () => {
  class FakeQueue {
    readonly name: string;
    constructor(name: string, options: unknown) {
      this.name = name;
      constructed.push({ name, options });
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
});

describe("createQueueStats", () => {
  /**
   * The page is a reader. Without `skipMetasUpdate` the constructor of a
   * `Queue` writes `bull:<name>:meta` on its way to ready - creating meta keys
   * for queues nobody has run yet and overwriting the event stream bound the
   * worker set.
   */
  it("opens every queue without letting it write the meta key", async () => {
    const stats = createQueueStats({ connection });

    await stats.collect();

    expect(constructed).toHaveLength(QUEUE_NAMES.length);
    for (const queue of constructed) {
      expect(queue.options).toMatchObject({ skipMetasUpdate: true });
    }
  });

  it("reports the counters and the depth of the dlq", async () => {
    const stats = createQueueStats({ connection });

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
    const stats = createQueueStats({ connection });

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
    const stats = createQueueStats({ connection });

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
    beforeCounts = () => new Promise<void>(() => {});
    const stats = createQueueStats({ connection, drainTimeoutMs: 20 });
    // Nobody is ever going to await this one; it is the request Redis ate.
    void stats.collect().catch(() => {});
    // Let the pass reach the fake queues before the close begins.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await stats.close();

    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);
  });

  /**
   * BullMQ connects once - `initializing` is assigned in the constructor and
   * never retried - so a `Queue` whose init rejected answers every later call
   * with the same rejection. Kept in the map, it would leave the page showing
   * `redis: down` long after Redis came back, until someone restarted the api.
   */
  it("throws away a queue whose read failed so the next request rebuilds it", async () => {
    const stats = createQueueStats({ connection });
    beforeCounts = async () => {
      throw new Error("Connection is closed.");
    };

    await expect(stats.collect()).rejects.toThrow(/Connection is closed/);
    expect(constructed).toHaveLength(QUEUE_NAMES.length);
    expect(closedQueues).toHaveLength(QUEUE_NAMES.length);

    // Redis is back; the next request must not inherit the broken objects.
    beforeCounts = async () => {};
    await expect(stats.collect()).resolves.toMatchObject({ dlq: { size: 3 } });
    expect(constructed).toHaveLength(QUEUE_NAMES.length * 2);

    await stats.close();
  });

  it("refuses a request that arrives after the close", async () => {
    const stats = createQueueStats({ connection });
    await stats.close();

    await expect(stats.collect()).rejects.toThrow(/closed/);
  });
});
