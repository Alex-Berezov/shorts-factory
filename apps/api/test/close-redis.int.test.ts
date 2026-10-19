import { closeRedis } from "@sf/runtime";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { openTestRedis, whenReady } from "./helpers.int.js";

/**
 * `closeRedis` of `@sf/runtime` on the client of requests and a real Redis
 * (`infra/docker-compose.yml`): its unit cases stub the client, and what they
 * stub - the states ioredis reports and how its `quit()` answers - is what a
 * new version of ioredis would change. Here it is the version that ships.
 */

/**
 * Waits until the client has ended. ioredis says `end` once the socket has
 * closed, a moment after `quit()` resolves or `disconnect()` returns - not at
 * once (the status right after either is still `ready` or `reconnecting`).
 */
async function ended(redis: Redis): Promise<void> {
  await vi.waitFor(
    () => {
      expect(redis.status).toBe("end");
    },
    { timeout: 2_000, interval: 10 },
  );
}

/**
 * The delay before the dropped client of a case tries again, set by the case
 * itself: ioredis sets `reconnecting` in the tick that schedules the `close`
 * event; the first retry is a timer of RECONNECT_DELAY_MS and cannot run
 * before the continuation of `await dropped`. The watch for a reconnect is
 * counted from a delay the case chose, not from the default backoff of
 * ioredis.
 */
const RECONNECT_DELAY_MS = 200;
/** How long the case watches for a reconnect that must not come. */
const RECONNECT_WATCH_MS = RECONNECT_DELAY_MS * 5;

describe("closeRedis against a live Redis", () => {
  it("quits a connected client and leaves it ended", async () => {
    const redis = openTestRedis();
    try {
      await whenReady(redis);

      await expect(closeRedis(redis)).resolves.toEqual({ kind: "quit" });
      await ended(redis);
    } finally {
      redis.disconnect();
    }
  });

  it("tears down a client whose connection the server dropped", async () => {
    const redis = openTestRedis();
    const admin = openTestRedis();
    try {
      await Promise.all([whenReady(redis), whenReady(admin)]);
      redis.options.retryStrategy = () => RECONNECT_DELAY_MS;
      const id = String(await redis.client("ID"));
      const dropped = new Promise<void>((resolve) => {
        redis.once("close", () => {
          resolve();
        });
      });

      await admin.client("KILL", "ID", id);
      await dropped;

      // Waiting to reconnect once the socket is gone: ioredis sets
      // `reconnecting` in the tick that schedules the `close` event, and the
      // first retry is a timer of RECONNECT_DELAY_MS that cannot run before
      // this continuation. No QUIT is sent to a server that is not listening
      // on it - the client is torn down instead.
      expect(redis.status).toBe("reconnecting");
      let cameBack = false;
      redis.on("connect", () => {
        cameBack = true;
      });
      await expect(closeRedis(redis)).resolves.toEqual({
        kind: "disconnected",
      });

      // Gone for good: no reconnect within five times the delay it would
      // have waited. ioredis leaves the status of a client torn down while it
      // waited to reconnect at `reconnecting` - there is no socket to close -
      // so the proof is the reconnect that never comes, not `end`.
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_WATCH_MS));
      expect(cameBack).toBe(false);
    } finally {
      redis.disconnect();
      admin.disconnect();
    }
  });
});
