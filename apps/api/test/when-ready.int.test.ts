import { createRequestRedis } from "@sf/runtime";
import { describe, expect, it } from "vitest";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";
import { whenReady } from "./helpers.int.js";

/** Nothing listens here - a refused connection, not a slow one. */
const CLOSED_REDIS_URL = "redis://127.0.0.1:6399";

/**
 * How soon a refusal must come back: far under the five seconds `whenReady`
 * gives a client that never answers, so the case tells a refusal it names
 * from a wait that ran out.
 */
const REFUSAL_WITHIN_MS = 1_000;

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
      const startedAt = Date.now();
      await expect(whenReady(redis)).rejects.toThrow(
        /failed to connect: .*ECONNREFUSED/,
      );
      expect(Date.now() - startedAt).toBeLessThan(REFUSAL_WITHIN_MS);
    } finally {
      redis.disconnect();
    }
  });
});
