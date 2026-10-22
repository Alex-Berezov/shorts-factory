import { type Db, closeDb } from "@sf/db";
import {
  type ClosableRedis,
  type RepeatedSigint,
  type ShutdownStage,
  createShutdownHandler,
  redisStage,
  stageOf,
  subscribeToSignals,
} from "@sf/runtime";
import type { Logger } from "pino";
import type { WorkerRuntime } from "./runtime.js";

/**
 * How long the stop gets before the process is torn down anyway. Longer than
 * the api's ten seconds: the first stage waits for jobs that are running, and
 * a job is allowed to take longer than a request.
 *
 * Whoever sent the signal has a deadline of its own, and it is shorter than
 * this one by default: `docker stop` - and Compose with it - sends SIGKILL ten
 * seconds after the signal unless the service declares `stop_grace_period`.
 * So this number only holds where that is declared, and E0-11 declares it
 * (`stop_grace_period: 30s` on the worker service, docs/30_E0_TASKS.md). Under
 * a shorter grace the container is killed mid-drain and the exit code is not
 * ours: a job in flight comes back through the stalled scan instead.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * A second Ctrl+C leaves at once: the operator does not want to wait for the
 * drain, and the jobs it was running come back to the queue as stalled, which
 * is safe because every job is idempotent. Compose only ever sends SIGTERM,
 * so the graceful stop of a container is not affected.
 */
const REPEATED_SIGINT: RepeatedSigint = {
  hint: "press Ctrl+C again to exit now; unfinished jobs will be retried",
  forcedMessage: "forced exit, active jobs return as stalled",
};

/**
 * The order the worker process starts and stops in, without the connections
 * it starts and stops with. `src/index.ts` reads the environment and opens
 * Redis and Postgres; everything that has to happen in a particular order
 * happens here, where a test can watch it.
 *
 * The order is the contract, and the first line of it is the subscription:
 * signals are listened for **before** the runtime is started. A `Worker` takes
 * jobs from the moment it is constructed, and starting the runtime takes as
 * long as Redis and Postgres need to answer - a SIGTERM inside that window
 * (a redeploy, a `docker compose down`) would otherwise be handled by Node's
 * default action, which is to end the process on the spot, together with
 * whatever the first worker has already picked up.
 */
export interface BootstrapOptions {
  log: Logger;
  /** Starts the runtime; whatever it opens is closed before the connections. */
  start(): Promise<WorkerRuntime>;
  /**
   * The connections the entry point owns, in closing order - after the
   * workers have drained and the queues are closed, never before.
   */
  connections: readonly ShutdownStage[];
  /** Seam for tests; production listens for SIGINT and SIGTERM. */
  subscribe?(handler: (signal: string) => void): void;
  /** Seam for tests; the process really does exit in production. */
  exit?(code: number): void;
  /** Deadline of the whole stop; `SHUTDOWN_TIMEOUT_MS` when left out. */
  timeoutMs?: number;
}

/**
 * The connections of the entry point as the last stages of the stop, in
 * closing order: Redis, then the database. Redis goes through `redisStage` of
 * `@sf/runtime` (its own module on top of `closeRedis` and `stageOf`), the
 * same stage as the api's: a QUIT that was refused, or a client torn down
 * because it was not connected, is a `warn` that says so - with the refusal -
 * rather than a `closed` that hides it. The database is a stage of `stageOf`,
 * the way the api builds its own.
 */
export function connectionStages(
  redis: ClosableRedis,
  db: Db,
): ShutdownStage[] {
  return [redisStage(() => redis), stageOf("db", () => db, closeDb)];
}

/**
 * Starts the runtime under a shutdown that is already listening, and returns
 * the runtime for a caller that wants it (a test; the entry point does not).
 *
 * A start that throws is not left half-open: `startWorkerRuntime` closes what
 * it managed to create, and the stop below closes the connections and leaves
 * with a non-zero code.
 */
export async function bootstrap(
  options: BootstrapOptions,
): Promise<WorkerRuntime | undefined> {
  /**
   * Resolved with the runtime, or with nothing if the start failed. The
   * stages read it instead of a variable assigned after `await`: a signal in
   * the start window runs them while that assignment is still queued.
   */
  let started: Promise<WorkerRuntime | undefined> = Promise.resolve(undefined);

  const shutdown = createShutdownHandler({
    // In this order, and the order is the contract: workers (each one
    // draining its active jobs), then the queues and their event streams, then
    // the connections. A connection closed while a job is still running loses
    // that job, and closing Redis before the workers takes away the socket
    // they need to release their locks.
    // A start that failed has no runtime: both stages say "not opened" then,
    // not `closed` for workers and queues that never existed.
    plan: [
      stageOf(
        "workers",
        () => started,
        (runtime) => runtime.closeWorkers(),
      ),
      stageOf(
        "queues",
        () => started,
        (runtime) => runtime.closeQueues(),
      ),
      ...options.connections,
    ],
    log: options.log,
    startedMessage: "shutdown started, draining active jobs",
    repeatedSigint: REPEATED_SIGINT,
    timeoutMs: options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS,
    ...(options.exit === undefined ? {} : { exit: options.exit }),
  });

  const subscribe = options.subscribe ?? subscribeToSignals;
  subscribe((signal) => {
    void shutdown(signal);
  });

  const starting = options.start();
  // The failure is handled below; this copy only keeps the stages from
  // rejecting when they wait for a start that never finished.
  started = starting.catch(() => undefined);

  try {
    return await starting;
  } catch (err) {
    options.log.fatal({ err }, "worker failed to start");
    await shutdown("startup failure", { failed: true });
    return undefined;
  }
}
