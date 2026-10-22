import { createRequestRedis } from "@sf/runtime";
import { describe, expect, it } from "vitest";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";
import { READY_TIMEOUT_MS, whenReady } from "./helpers.int.js";

/** Nothing listens here - a refused connection, not a slow one. */
const CLOSED_REDIS_URL = "redis://127.0.0.1:6399";

/**
 * How soon a refusal must come back. What the bound tells apart is the other
 * way `whenReady` can end: its wait for a client that never answers runs
 * out after `READY_TIMEOUT_MS` (`helpers.int.ts`, read from there, so a new
 * wait moves the bound with it). Half of that wait still tells the two
 * apart, and leaves a loaded runner the rest - a refusal takes milliseconds.
 */
const REFUSAL_WITHIN_MS = READY_TIMEOUT_MS / 2;

/**
 * The wait of the integration files for a usable client (`helpers.int.ts`):
 * a Redis that is not there is a failure that names the refusal, at once,
 * not a case that runs out its own timeout and names nothing.
 */
describe("whenReady", () => {
  it("fails with the refusal of a Redis that is not there", async () => {
    const redis = createRequestRedis(CLOSED_REDIS_URL, {
      commandTimeoutMs: DEPENDENCY_TIMEOUT_MS,
    });
    try {
      // Monotonic: a step of the wall clock is no time the refusal took.
      const startedAt = performance.now();
      await expect(whenReady(redis)).rejects.toThrow(
        /failed to connect: .*ECONNREFUSED/,
      );
      expect(performance.now() - startedAt).toBeLessThan(REFUSAL_WITHIN_MS);
    } finally {
      redis.disconnect();
    }
  });
});
