import { ZodError, type ZodIssue } from "zod";
import type { EnvLike } from "../src/env-file.js";

/**
 * Smallest source that parses: the fields without a default, plus the
 * environment - undeclared means production, where the short fixture password
 * is rejected on purpose. Shared so that a new required key is added in one
 * place instead of reddening unrelated tests with a stale literal.
 */
export function baseSource(overrides: EnvLike = {}): EnvLike {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://sf:sf@localhost:5432/shorts_factory",
    REDIS_URL: "redis://localhost:6379",
    ADMIN_PASSWORD: "testtest",
    ...overrides,
  };
}

/**
 * Issues Zod reported, so a test can assert on the wording an operator sees
 * and not only on the field name. A run that does not throw is a failure of
 * the test's own premise, reported with the message the caller gives.
 */
export function envIssues(
  run: () => unknown,
  onPass = "expected loadEnv to throw",
): ZodIssue[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ZodError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error(onPass);
}

/**
 * Field names Zod reported, so a test can name the field it expects.
 */
export function issuePaths(
  run: () => unknown,
  onPass = "expected loadEnv to throw",
): string[] {
  return envIssues(run, onPass).map((issue) => issue.path.join("."));
}
