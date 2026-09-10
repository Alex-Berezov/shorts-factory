import type { Env } from "@sf/config";
import { QUEUE_NAMES, type QueueName } from "@sf/core";
import type { Db } from "@sf/db";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { JOB_PROCESSORS } from "./jobs/index.js";
import type { QueueProcessor } from "./lib/define-job.js";
import { type DlqWriter, createDlqWriter } from "./lib/dlq.js";
import { queueConcurrency } from "./lib/job-policy.js";
import {
  applyQueueSwitches,
  startQueueSwitchSync,
} from "./lib/queue-switches.js";
import { type QueueFactory, createQueueFactory } from "./lib/queues.js";
import { syncSchedules } from "./schedules.js";

/**
 * The worker itself: queues, workers, the DLQ wiring, the queue switches and
 * the cron registry, started in one call and closed in two.
 *
 * Everything it needs is passed in - the environment is read once in
 * `src/index.ts`, the connections are opened there and closed there. That is
 * what lets an integration test run the whole runtime in-process against the
 * test database and stop it without touching a global.
 */
export interface WorkerRuntimeDeps {
  env: Env;
  db: Db;
  redis: Redis;
  log: Logger;
  /**
   * Overridable so a test can run a queue of its own; production uses all.
   * The value may be `undefined` under a name that is present - a registry
   * built with a spread or `Object.fromEntries` produces exactly that - and
   * the start below checks rather than assumes.
   */
  processors?: Partial<Record<QueueName, QueueProcessor | undefined>>;
  /** How often the queue switches are re-read. */
  switchIntervalMs?: number;
  /**
   * Overridable so a test can watch what the runtime does with the queues -
   * how long a dlq write takes, in particular. Production opens its own and
   * closes them in `closeQueues`.
   */
  queues?: QueueFactory;
}

export interface WorkerRuntime {
  queues: QueueFactory;
  /** The queues this process has a handler for. */
  handled: QueueName[];
  /** Stops the switch resync and drains the workers; safe to call twice. */
  closeWorkers(): Promise<void>;
  /** Closes the queue objects; call after `closeWorkers`. */
  closeQueues(): Promise<void>;
  /** Both of the above, in order - for a caller with no staged shutdown. */
  close(): Promise<void>;
}

export async function startWorkerRuntime(
  deps: WorkerRuntimeDeps,
): Promise<WorkerRuntime> {
  const processors = deps.processors ?? JOB_PROCESSORS;
  const queues = deps.queues ?? createQueueFactory(deps.redis);
  const getQueue = (name: QueueName) => queues.get(name);

  const workers = new Map<QueueName, Worker>();
  const dlqWriters: DlqWriter[] = [];
  let stopSwitchSync: () => Promise<void> = async () => {};
  let workersClosed = false;
  let queuesClosed = false;

  const closeWorkers = async (): Promise<void> => {
    if (workersClosed) {
      return;
    }
    workersClosed = true;
    // Awaited: a tick in flight is holding a queue open and is about to ask
    // the factory for more, and the factory is closed a moment from now.
    await stopSwitchSync();
    // `close()` without `force`: it stops taking new jobs and waits for the
    // ones in flight - the whole point of a graceful stop.
    await Promise.all([...workers.values()].map((worker) => worker.close()));
    // Only now can no new failure arrive; what is left is the copies already
    // on their way to `system.dlq`, which the next stage would cut off.
    await Promise.all(dlqWriters.map((writer) => writer.drain()));
  };

  const closeQueues = async (): Promise<void> => {
    if (queuesClosed) {
      return;
    }
    queuesClosed = true;
    await queues.close();
  };

  try {
    await startEverything();
  } catch (err) {
    // A start that threw halfway still owns what it managed to create: a
    // `Worker` already taking jobs, a resync timer, a `Queue` with listeners.
    // The caller has no handle on any of it, so it is closed here, by the
    // same stages a signal would use.
    deps.log.error({ err }, "worker runtime failed to start, closing it back");
    await closeWorkers().catch((closeErr: unknown) => {
      deps.log.error({ err: closeErr }, "close failed while unwinding a start");
    });
    await closeQueues().catch((closeErr: unknown) => {
      deps.log.error({ err: closeErr }, "close failed while unwinding a start");
    });
    throw err;
  }

  return {
    queues,
    handled: [...workers.keys()],
    closeWorkers,
    closeQueues,
    async close(): Promise<void> {
      await closeWorkers();
      await closeQueues();
    },
  };

  /** The start itself; everything it opens is reachable from above. */
  async function startEverything(): Promise<void> {
    // Shared by the start and the resync below: a queue the setting says
    // nothing about is worth one warning, not one a minute forever.
    const warned = new Set<string>();

    // Before anything is started: a database with no switches means a database
    // that was never seeded, and the worker says so instead of guessing.
    await applyQueueSwitches({ db: deps.db, log: deps.log, getQueue, warned });
    stopSwitchSync = startQueueSwitchSync({
      db: deps.db,
      log: deps.log,
      getQueue,
      warned,
      ...(deps.switchIntervalMs === undefined
        ? {}
        : { intervalMs: deps.switchIntervalMs }),
    });

    await syncSchedules({ getQueue, log: deps.log });

    const dlq = queues.get("system.dlq");

    // Walked in registry order, and the entry is checked rather than cast: the
    // map is `Partial`, so a name whose value is `undefined` (a registry built
    // with a spread, or with a flag) would otherwise get a `Worker` with no
    // processor - the queue looks served in the log and the first job dies on
    // `processor.process is not a function`.
    for (const name of QUEUE_NAMES) {
      const processor = processors[name];
      if (processor === undefined) {
        continue;
      }
      const concurrency = queueConcurrency(name, deps.env.WORKER_CONCURRENCY);
      const worker = new Worker(
        name,
        async (job) => {
          await processor.process(job, {
            log: deps.log,
            db: deps.db,
            redis: deps.redis,
          });
        },
        { connection: deps.redis, concurrency },
      );

      const dlqWriter = createDlqWriter({ queue: name, dlq, log: deps.log });
      dlqWriters.push(dlqWriter);
      // The writer never rejects (see `lib/dlq.ts`): an unhandled rejection in
      // an event listener ends the process together with the jobs it is running.
      // What it does keep is the copy it started, so that the stop below can
      // wait for it instead of closing Redis out from under it.
      worker.on("failed", (job, err) => {
        dlqWriter.onFailed(job, err);
      });
      // Without an `error` listener a connection problem reaches the process as
      // an unhandled `EventEmitter` error and does the same.
      worker.on("error", (err) => {
        deps.log.error({ queue: name, err }, "worker error");
      });

      workers.set(name, worker);
      deps.log.info({ queue: name, concurrency }, "worker started");
    }

    const handled = [...workers.keys()];
    deps.log.info(
      {
        registered: QUEUE_NAMES.length,
        handled: handled.length,
        queues: handled,
      },
      "worker runtime started",
    );
  }
}
