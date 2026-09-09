import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ClosableRedis,
  closeRedis,
  createRedis,
} from "../src/lib/redis.js";

/** Records how the client was asked to go away, and how it answered. */
function stubClient(quitFails: boolean): ClosableRedis & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    quit: async () => {
      calls.push("quit");
      if (quitFails) {
        // What ioredis answers with `enableOfflineQueue: false` on a client
        // that never connected or is reconnecting.
        throw new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        );
      }
      return "OK";
    },
    disconnect: () => {
      calls.push("disconnect");
    },
  };
}

describe("closeRedis", () => {
  it("quits a connected client and leaves it at that", async () => {
    const client = stubClient(false);

    await closeRedis(client);

    expect(client.calls).toEqual(["quit"]);
  });

  it("tears the socket down when quit is refused", async () => {
    // The stop of a service whose Redis is down: `quit()` is rejected because
    // the command cannot be written, and the shutdown would report a failed
    // close and exit with 1 - a clean stop that reads as a crash to Compose.
    const client = stubClient(true);

    await expect(closeRedis(client)).resolves.toBeUndefined();
    expect(client.calls).toEqual(["quit", "disconnect"]);
  });
});

describe("createRedis", () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it("handles connection failures itself instead of taking the process down", () => {
    // Port 1 on the loopback refuses immediately. An `error` event without a
    // listener is rethrown by `EventEmitter`, so a Redis that is down would
    // kill the api instead of showing up as `redis: "down"`.
    client = createRedis("redis://127.0.0.1:1");

    expect(client.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      client?.emit("error", new Error("connect ECONNREFUSED")),
    ).not.toThrow();
  });

  it("reports a connection failure to the caller", () => {
    const seen: string[] = [];
    client = createRedis("redis://127.0.0.1:1", {
      onError: (err) => seen.push(err.message),
    });

    client.emit("error", new Error("connect ECONNREFUSED"));

    expect(seen).toEqual(["connect ECONNREFUSED"]);
  });
});
