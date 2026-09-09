import {
  type BuildInfo,
  type ErrorBody,
  ErrorBodySchema,
  type HealthReport,
} from "@sf/contracts";
import {
  type AppInstance,
  type BuildAppOptions,
  buildApp,
} from "../src/app.js";
import type { AppDeps, HealthProbes } from "../src/deps.js";

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

interface AppOverrides {
  buildInfo?: BuildInfo;
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
