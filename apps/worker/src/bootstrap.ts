import type { Logger } from "pino";
import { type ShutdownStage, createShutdownHandler } from "./lib/shutdown.js";
import type { WorkerRuntime } from "./runtime.js";

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
  /** Deadline of the whole stop; the default lives in `lib/shutdown.ts`. */
  timeoutMs?: number;
}

/** SIGINT is Ctrl+C in a console, SIGTERM is what an orchestrator sends. */
function subscribeToSignals(handler: (signal: string) => void): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      handler(signal);
    });
  }
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
    stages: [
      {
        name: "workers",
        close: async () => {
          await (await started)?.closeWorkers();
        },
      },
      {
        name: "queues",
        close: async () => {
          await (await started)?.closeQueues();
        },
      },
      ...options.connections,
    ],
    log: options.log,
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
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
