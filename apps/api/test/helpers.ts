import {
  type BudgetStatus,
  type BuildInfo,
  type ErrorBody,
  ErrorBodySchema,
  type HealthReport,
  type WorkerStatus,
} from "@sf/contracts";
import { QUEUE_NAMES } from "@sf/core";
import {
  type AppInstance,
  type BuildAppOptions,
  buildApp,
} from "../src/app.js";
import type {
  AppDeps,
  BudgetProbe,
  HealthProbes,
  QueueStatsProbe,
  QueuesSnapshot,
  WorkerProbe,
} from "../src/deps.js";

/** Password every test app is built with; the user name is never checked. */
export const TEST_PASSWORD = "test-admin-password";

/** Ready-made `Authorization` value for a request that should be let in. */
export const AUTH_HEADER = basicAuthHeader(TEST_PASSWORD);

/** Basic credentials with an arbitrary user name, as a client would send. */
export function basicAuthHeader(password: string, username = "admin"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * The two ways to say what the probes do, and only one of them per app: the
 * probes replaced wholesale ignore whatever report was asked for, so a case
 * that set both would be green for a reason its author did not write. Stating
 * it in the type makes the pair a compile failure instead of a silent one.
 */
type ProbeOverride =
  | {
      /** Health report the stubbed probes return; both up by default. */
      report?: Partial<HealthReport>;
      health?: never;
    }
  | {
      /**
       * The probes themselves, for the tests where the interesting part is
       * not what they report but that they threw: a failure on `/health`
       * leaves through the error handler with a status the route also
       * answers with.
       */
      health?: HealthProbes;
      report?: never;
    };

/**
 * The collectors of `/system/status`, stubbed with the smallest believable
 * answer. A test that is about one of them passes its own; a test that is
 * about something else must still get a page that parses, or its failure would
 * be about the fixture rather than about the route.
 */
export const EMPTY_QUEUES: QueuesSnapshot = {
  queues: QUEUE_NAMES.map((name) => ({
    name,
    waiting: 0,
    active: 0,
    failed: 0,
    delayed: 0,
    paused: false,
  })),
  dlq: { size: 0 },
};

export const LIVE_WORKER: WorkerStatus = {
  heartbeatAt: "2026-09-13T10:00:00.000Z",
  stale: false,
};

export const IDLE_BUDGET: BudgetStatus[] = [
  {
    key: "youtube_data_units_day",
    measure: "units",
    period: "day",
    timeZone: "America/Los_Angeles",
    spent: 0,
    cap: 8_000,
    ratio: 0,
    warn: false,
    exceeded: false,
  },
];

interface AppOverrides {
  buildInfo?: BuildInfo;
  /** The collectors behind `/system/status`; stubs unless a test says more. */
  queues?: QueueStatsProbe;
  worker?: WorkerProbe;
  budget?: BudgetProbe;
  adminPassword?: string;
  /**
   * Routes that exist only for a test - the error paths need a handler that
   * throws, and the application itself has no reason to have one.
   */
  routes?: (app: AppInstance) => void;
  /**
   * Logging is off unless a test is about what gets written: the error handler
   * decides what of a failure reaches the log, and the only way to assert that
   * is to give pino a stream and read the lines back.
   */
  logger?: BuildAppOptions["logger"];
}

export type TestAppOverrides = AppOverrides & ProbeOverride;

/**
 * `buildApp` with stubbed dependencies and no logging: the probes are the only
 * thing between these tests and a real database, and pino output would drown
 * the run.
 */
export function buildTestApp(overrides: TestAppOverrides = {}): AppInstance {
  const report: HealthReport = { db: "up", redis: "up", ...overrides.report };
  const deps: AppDeps = {
    health: overrides.health ?? { check: async () => report },
    buildInfo: overrides.buildInfo ?? {
      version: "0.0.1-test",
      commit: "abc1234",
    },
    queues: overrides.queues ?? { collect: async () => EMPTY_QUEUES },
    worker: overrides.worker ?? { read: async () => LIVE_WORKER },
    budget: overrides.budget ?? { collect: async () => IDLE_BUDGET },
  };

  const app = buildApp(deps, {
    adminPassword: overrides.adminPassword ?? TEST_PASSWORD,
    logger: overrides.logger ?? false,
  });
  overrides.routes?.(app);

  return app;
}

/**
 * The error envelope as a client sees it - the schema the client package
 * parses with, not a copy of it: parsing instead of casting keeps the
 * assertions honest, and taking the schema from `@sf/contracts` means a
 * response that drifted from the shape fails here rather than in web.
 */
export function parseErrorBody(payload: string): ErrorBody {
  return ErrorBodySchema.parse(JSON.parse(payload));
}
