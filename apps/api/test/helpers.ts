import { z } from "zod";
import {
  type AppInstance,
  type BuildAppOptions,
  buildApp,
} from "../src/app.js";
import type { AppDeps, BuildInfo, HealthReport } from "../src/deps.js";

/** Password every test app is built with; the user name is never checked. */
export const TEST_PASSWORD = "test-admin-password";

/** Ready-made `Authorization` value for a request that should be let in. */
export const AUTH_HEADER = basicAuthHeader(TEST_PASSWORD);

/** Basic credentials with an arbitrary user name, as a client would send. */
export function basicAuthHeader(password: string, username = "admin"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export interface TestAppOverrides {
  /** Health report the stubbed probes return; both dependencies up by default. */
  report?: Partial<HealthReport>;
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

/**
 * `buildApp` with stubbed dependencies and no logging: the probes are the only
 * thing between these tests and a real database, and pino output would drown
 * the run.
 */
export function buildTestApp(overrides: TestAppOverrides = {}): AppInstance {
  const report: HealthReport = { db: "up", redis: "up", ...overrides.report };
  const deps: AppDeps = {
    health: { check: async () => report },
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
 * The error envelope as a client sees it. Parsing instead of casting keeps the
 * assertions honest: a response that drifted from the shape fails here.
 */
const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export function parseErrorBody(payload: string): ErrorBody {
  return ErrorBodySchema.parse(JSON.parse(payload));
}
