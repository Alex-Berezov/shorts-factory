import type {
  BudgetStatus,
  BuildInfo,
  DlqStatus,
  HealthReport,
  QueueStatus,
  WorkerStatus,
} from "@sf/contracts";

/**
 * How the application is wired, and only that: what the routes answer is
 * declared in `@sf/contracts`, where web reads the same objects, and the
 * shapes this module used to hold moved there in E0-07.
 *
 * Every collaborator below is an interface rather than the implementation from
 * `lib/`, so `buildApp` - and with it every route test - stays free of a
 * database handle, a Redis socket and 29 `Queue` objects.
 */
export interface HealthProbes {
  check(): Promise<HealthReport>;
}

/**
 * The queue counters and the DLQ depth, read together: they come from one pass
 * over Redis, and a page that showed one without the other would invite the
 * reading "the DLQ is empty" when it is simply unknown.
 */
export interface QueuesSnapshot {
  queues: QueueStatus[];
  dlq: DlqStatus;
}

export interface QueueStatsProbe {
  collect(): Promise<QueuesSnapshot>;
}

/** Liveness of the worker, from the heartbeat key it writes. */
export interface WorkerProbe {
  read(): Promise<WorkerStatus>;
}

/** Where every cap stands right now. */
export interface BudgetProbe {
  collect(): Promise<BudgetStatus[]>;
}

/**
 * Everything `buildApp` receives from its caller. Owning the connections is
 * `server.ts`'s job: this object carries only what the routes read, which is
 * why the probes here have no `close()` - the factory that has one stays with
 * whoever opened it.
 */
export interface AppDeps {
  health: HealthProbes;
  buildInfo: BuildInfo;
  queues: QueueStatsProbe;
  worker: WorkerProbe;
  budget: BudgetProbe;
}
