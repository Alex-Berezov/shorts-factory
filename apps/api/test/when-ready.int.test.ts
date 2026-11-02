import { EventEmitter } from "node:events";
import { createRequestRedis } from "@sf/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A client that never says it is ready, whose status a case moves on. */
class SilentClient extends EventEmitter {
  status = "connecting";
}

/**
 * The wait of the integration files for a usable client (`helpers.int.ts`):
 * a Redis that is not there is a failure that names the refusal, at once,
 * not a case that runs out its own timeout and names nothing.
 */
describe("whenReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("names the status the client has when the wait runs out, not the one it began with", async () => {
    vi.useFakeTimers();
    const client = new SilentClient();
    const verdict = expect(whenReady(client)).rejects.toThrow(
      `the test Redis client to be ready: no answer within ${READY_TIMEOUT_MS} ms (status reconnecting)`,
    );

    client.status = "reconnecting";
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);

    await verdict;
    expect(client.listenerCount("ready")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });
});
