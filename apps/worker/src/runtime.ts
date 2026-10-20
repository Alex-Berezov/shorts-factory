import { type Env, buildLimits } from "@sf/config";
import { QUEUE_NAMES, type QueueName } from "@sf/core";
import { type BudgetGuard, type Db, createUsageLogger } from "@sf/db";
import {
  type QueueFactory,
  connectionFailure,
  markClientErrors,
} from "@sf/runtime";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { JOB_PROCESSORS } from "./jobs/index.js";
// Past the barrel on purpose: `jobs/index.ts` is the registry of the queues
// this process runs, and a step of the start is not a processor. The stamp it
// clears belongs to the heartbeat job, so the helper lives with that job - and
// its one caller is the start below, where moving the call would be noticed.
import { clearHeartbeat } from "./jobs/system-heartbeat.js";
import { createWorkerBudgetGuard } from "./lib/budget.js";
import type { QueueProcessor } from "./lib/define-job.js";
import { type DlqWriter, createDlqWriter } from "./lib/dlq.js";
import { createJobQueueFactory, queueConcurrency } from "./lib/job-policy.js";
import {
  applyQueueSwitches,
  startQueueSwitchSync,
} from "./lib/queue-switches.js";
import { syncSchedules } from "./schedules.js";

/**
 * How long an unmarked connection failure of a `Worker` silences the next one
 * when the worker does not say `ready` in between (the `error` listener in
 * `startWorkerRuntime`).
 */
export const CONNECTION_FAILURE_LOG_WINDOW_MS = 60_000;

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
   * Overridable so a test can run against caps of its own; production builds
   * one guard per process from `env` and the Redis above.
   */
  budget?: BudgetGuard;
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
  // One guard for the process: it caches the totals, and a guard per job would
  // multiply exactly the round trips that cache exists to avoid.
  const budget =
    deps.budget ??
    createWorkerBudgetGuard({
      db: deps.db,
      redis: deps.redis,
      limits: buildLimits(deps.env),
      log: deps.log,
    });
  const queues = deps.queues ?? createJobQueueFactory(deps.redis, deps.log);
  const getQueue = (name: QueueName) => queues.get(name);
  // Before the first `Worker` is built on the client: BullMQ hands every error
  // of the shared client to every `Worker` on it, and this listener has to run
  // ahead of theirs for the copy they hear to be marked. The client writes its
  // own line; one more per worker would be a line per queue per reconnect.
  const clientErrors = markClientErrors(deps.redis);

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
    // the factory for more, and the factory is closed a moment from now. It
    // never rejects (see `lib/queue-switches.ts`), so the close below runs.
    await stopSwitchSync();
    // `close()` without `force`: it stops taking new jobs and waits for the
    // ones in flight - the whole point of a graceful stop.
    try {
      await Promise.all([...workers.values()].map((worker) => worker.close()));
    } finally {
      // No `Worker` hears the client any more.
      clientErrors.dispose();
    }
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

    // Right after the switches, before the switch resync, the schedules and
    // any worker: the stamp in Redis may be one the previous process left in
    // the `redisdata` volume, and with a TTL of three ticks it would make this
    // process healthy for up to 3 min before it has done anything. Not before
    // the switches: a database that was never seeded has to be the first error
    // the operator sees. Nothing before this point runs a job, so the stamp
    // cleared here cannot be one this process has written. Without it the
    // healthcheck answers "no stamp" until the first tick, which comes within
    // 60 s - inside the `start_period: 90s` of the compose healthcheck. A
    // rejected `DEL` fails the start like any other step here; a Redis that is
    // down makes it wait, as it does them (the connection is BullMQ's, with no
    // request retry limit). The price: a second worker started next to a live
    // one (dev on the host and the container) clears its neighbour's stamp,
    // which reads stale on `/system` until the next tick of either.
    await clearHeartbeat(deps.redis);

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
            budget,
            // Per run, so that every spend row carries the job that made the
            // call - a row with no job cannot be traced to what it paid for.
            createUsage: (jobId?: string) =>
              createUsageLogger(deps.db, jobId === undefined ? {} : { jobId }),
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
      // an unhandled `EventEmitter` error and does the same. Not written is an
      // error of the shared client: the client's own line has it, and every
      // worker on the client hears the same object. Each `Worker` also holds a
      // blocking copy of the client of its own (BullMQ duplicates it), whose
      // errors reach the worker unmarked and are nobody else's to write - so
      // here the worker departs from the factory of `Queue`, which writes no
      // connection failure at all (docs/DECISIONS.md, Т9 E0-12G). An unmarked
      // connection failure is written once, and again after either of two
      // things: the worker says `ready` - its copy came back - or
      // `CONNECTION_FAILURE_LOG_WINDOW_MS` has passed since the last line, by
      // the monotonic clock (`performance.now()`): a wall clock set back would
      // keep the window shut for as long as it went back. The window is for an
      // unmarked failure that is not the copy's (a `ConnectionClosedError` of
      // `run()`): no `ready` follows it, and without the window it would
      // silence the next outage of the copy for good. At worst a line per
      // worker per window, not one per reconnect. A wrong password on the
      // copies is still one line per worker per reconnect (docs/TECH_DEBT.md
      // § E0-12R).
      let connectionFailureWrittenAt: number | undefined;
      worker.on("ready", () => {
        connectionFailureWrittenAt = undefined;
      });
      worker.on("error", (err) => {
        if (clientErrors.has(err)) {
          return;
        }
        if (connectionFailure(err) !== undefined) {
          const now = performance.now();
          if (
            connectionFailureWrittenAt !== undefined &&
            now - connectionFailureWrittenAt < CONNECTION_FAILURE_LOG_WINDOW_MS
          ) {
            return;
          }
          connectionFailureWrittenAt = now;
        }
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
