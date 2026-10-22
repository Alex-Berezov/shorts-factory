import { type Env, buildLimits } from "@sf/config";
import { QUEUE_NAMES, type QueueName } from "@sf/core";
import { type BudgetGuard, type Db, createUsageLogger } from "@sf/db";
import { type QueueFactory, workerErrorPolicy } from "@sf/runtime";
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
   *
   * Built on `redis` above, and nothing else: the `Worker`s run on `redis`
   * and read the mark of this factory (`clientErrors`), which knows only the
   * errors of the client the factory was built on. A factory on another
   * client would leave every error of `redis` unmarked - a `worker error`
   * line per worker per reconnect.
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
  // The mark the factory put on the shared client before its first `Queue`,
  // so before the first `Worker` too: BullMQ hands every error of the client
  // to every `Worker` on it, and the mark has to run ahead of their listeners
  // for the copy they hear to be marked. One mark per client, and one owner of
  // it - the factory takes it off in its `close()`, which `close()` below
  // runs after the `Worker`s whatever they answered. A `Worker` that refused
  // to close and still hears the client hears it unmarked from then on.
  const { clientErrors } = queues;

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
    // ones in flight - the whole point of a graceful stop. Every `Worker` is
    // waited for, a refusal of one included: a refusal is no reason to leave
    // the others closing, nor to skip the drain below. The mark on the client
    // is not this stage's to take off; the factory does it in `closeQueues`.
    const workerList = [...workers.values()];
    const outcomes = await Promise.allSettled(
      workerList.map((worker) => worker.close()),
    );
    // A `Worker` that closed runs no job any more, so no new failure of it
    // can arrive; one that refused may still be running one, and a copy it
    // starts after the drain below is not waited for - the factory closed
    // next may cut it off. What the drain does keep is every copy already on
    // its way to `system.dlq`, and it runs before the refusal is thrown,
    // since `close()` closes the factory after a refused stage too.
    await Promise.all(dlqWriters.map((writer) => writer.drain()));
    throwRefusals(
      outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      ),
      (count) => `${count} of ${workerList.length} workers failed to close`,
    );
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
      // The queues are closed even when a `Worker` refused to: only the
      // factory takes its mark off the client. The refusal of the workers is
      // the one thrown; when the queues refuse as well, both go out in one
      // `AggregateError`, the workers first.
      const refusals: unknown[] = [];
      try {
        await closeWorkers();
      } catch (err) {
        refusals.push(err);
      }
      try {
        await closeQueues();
      } catch (err) {
        refusals.push(err);
      }
      throwRefusals(
        refusals,
        () => "the workers and the queues both failed to close",
      );
    },
  };

  /**
   * The refusals of one stop, thrown the way both stages above throw them:
   * nothing for none, a single one as it came, several together in one
   * `AggregateError` in the order they were collected - so that none of them
   * is lost behind another.
   */
  function throwRefusals(
    refusals: unknown[],
    message: (count: number) => string,
  ): void {
    if (refusals.length === 1) {
      throw refusals[0];
    }
    if (refusals.length > 1) {
      throw new AggregateError(refusals, message(refusals.length));
    }
  }

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

    // Asked for at every copy rather than held (`lib/dlq.ts`): the factory
    // forgets a `Queue` whose `init()` was refused, and a held one would stay
    // broken for the life of the process.
    const dlq = () => queues.get("system.dlq");

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
      // an unhandled `EventEmitter` error and does the same. What is written is
      // the rule of `workerErrorPolicy` of `@sf/runtime`, next to the rule of
      // the `Queue`s on the same client: not an error of the shared client, not
      // a refused password, an unmarked connection failure of the blocking copy
      // of the client once until the worker is `ready` again or the window has
      // passed (docs/DECISIONS.md, Т9 E0-12G), anything else every time. One
      // instance per `Worker`: the line of one worker silences nothing of
      // another.
      const errorPolicy = workerErrorPolicy(clientErrors);
      worker.on("ready", () => {
        errorPolicy.onReady();
      });
      worker.on("error", (err) => {
        if (errorPolicy.shouldWrite(err)) {
          deps.log.error({ queue: name, err }, "worker error");
        }
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
