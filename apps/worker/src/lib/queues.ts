import { type QueueName, isQueueName } from "@sf/core";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { DEFAULT_JOB_OPTIONS } from "./job-policy.js";

/**
 * Lazy `Queue` per name, with a cache.
 *
 * Lazy in the sense that nothing is created for a name nobody asks for - not
 * in the sense that a boot is cheap: `applyQueueSwitches` and `syncSchedules`
 * ask for every name of the registry while starting, so in the worker process
 * all of them do get opened (docs/TECH_DEBT.md, 10.09.2026). What the laziness
 * buys is a caller that touches one queue - the smoke command, a test, the api
 * when it starts enqueueing - paying for one. Cached because two `Queue`
 * objects for one name are two sets of listeners and two things to close, and
 * a job added through the second one would carry different default options.
 *
 * The connection is passed in and shared: `Queue` issues no blocking commands,
 * and BullMQ does not close a client it was handed (`RedisConnection` treats an
 * instance as shared), so the composition root closes it once.
 */
export interface QueueFactory {
  /** The queue for this name, created on first use; refused after `close`. */
  get(name: QueueName): Queue;
  /** Names opened so far - what the shutdown and the logs report. */
  opened(): QueueName[];
  /** Closes every queue that was opened; the connection is not touched. */
  close(): Promise<void>;
}

export function createQueueFactory(connection: Redis): QueueFactory {
  const cache = new Map<QueueName, Queue>();
  let closed = false;

  return {
    get(name: QueueName): Queue {
      // Refused once the factory is closed rather than quietly opening one
      // more: the cache is empty by then, so a latecomer (a switch resync that
      // was still running, a listener firing during the stop) would get a
      // brand new `Queue` with a set of listeners nobody is going to close,
      // and the process would hang until the shutdown deadline.
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
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      cache.set(name, queue);
      return queue;
    },

    opened(): QueueName[] {
      return [...cache.keys()];
    },

    async close(): Promise<void> {
      closed = true;
      const queues = [...cache.values()];
      cache.clear();
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}
