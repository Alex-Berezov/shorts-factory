import type { Redis } from "ioredis";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  type ClosableRedis,
  type ProbeRedisOptions,
  type QueueRedisOptions,
  closeRedis,
  createProbeRedis,
  createQueueRedis,
  createRequestRedis,
  redisStage,
} from "../src/redis.js";
import { NOT_OPENED } from "../src/shutdown.js";
import { recordingLogger } from "../test-support/recording-logger.js";

/** Nothing listens on port 1: the client is torn down before it matters. */
const CLOSED_REDIS_URL = "redis://127.0.0.1:1";

/** Records how the client was asked to go away, and how it answered. */
function stubClient(
  status: string,
  refusal?: Error,
): ClosableRedis & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status,
    quit: async () => {
      calls.push("quit");
      if (refusal !== undefined) {
        throw refusal;
      }
      return "OK";
    },
    disconnect: () => {
      calls.push("disconnect");
    },
  };
}

/**
 * The health a client reports through the logger it is given: the outage at a
 * level that fades, the reconnect that makes the next one news. Watched on the
 * client itself, the way an entry point gets it.
 */
describe("the health of a client", () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it("reports the first failure of an outage at error level and fades the rest", () => {
    // ioredis emits an `error` on every reconnect attempt, several times a
    // second: at a fixed level the log would bury everything else - including
    // the line that says the process went down.
    const { log, levels } = recordingLogger();
    client = createQueueRedis(CLOSED_REDIS_URL, { log });

    // Synchronous, so the refusals of port 1 cannot come in between.
    for (let i = 0; i < 7; i += 1) {
      client.emit("error", new Error("connect ECONNREFUSED"));
    }

    expect(levels()).toEqual([
      "error",
      "warn",
      "warn",
      "warn",
      "warn",
      "debug",
      "debug",
    ]);
  });

  it("makes the next outage news again after a reconnect, and says so", () => {
    // Built by hand at every entry point the wiring came out different in
    // each - the smoke CLI never subscribed the reset, so its reporter stayed
    // at `debug` for the rest of the run, whatever happened next.
    const { log, lines, levels } = recordingLogger();
    client = createQueueRedis(CLOSED_REDIS_URL, { log });

    client.emit("error", new Error("connect ECONNREFUSED"));
    client.emit("error", new Error("connect ECONNREFUSED"));
    client.emit("ready");
    client.emit("error", new Error("connect ECONNREFUSED"));

    expect(levels()).toEqual(["error", "warn", "info", "error"]);
    expect(lines[2]?.msg).toBe("redis connection ready");
  });
});

describe("closeRedis", () => {
  it("quits a connected client and leaves it at that", async () => {
    const client = stubClient("ready");

    await expect(closeRedis(client)).resolves.toEqual({ kind: "quit" });

    expect(client.calls).toEqual(["quit"]);
  });

  it.each(["reconnecting", "connecting", "close", "end", "wait"])(
    "tears down a client that is %s instead of asking it to quit",
    async (status) => {
      // On the queue client a QUIT issued while the socket is down waits in
      // the offline queue for a reconnect that may never come, and on the
      // client of requests it is refused: the stop would either hang to its
      // deadline and exit with 1, or log a failed close.
      const client = stubClient(status);

      await expect(closeRedis(client)).resolves.toEqual({
        kind: "disconnected",
      });

      expect(client.calls).toEqual(["disconnect"]);
    },
  );

  it("tears the socket down when a quit is refused, and says why", async () => {
    // The socket died between the status check and the QUIT.
    const refusal = new Error("Connection is closed.");
    const client = stubClient("ready", refusal);

    await expect(closeRedis(client)).resolves.toEqual({
      kind: "disconnected",
      err: refusal,
    });
    expect(client.calls).toEqual(["quit", "disconnect"]);
  });
});

describe("redisStage", () => {
  it("answers nothing of its own after a QUIT", async () => {
    const client = stubClient("ready");

    await expect(redisStage(() => client).close()).resolves.toBeUndefined();
  });

  it("answers a warning with the refusal when the QUIT was refused", async () => {
    // The worker wrote this as `closed`, and the refusal was lost.
    const refusal = new Error("Connection is closed.");
    const client = stubClient("ready", refusal);

    await expect(redisStage(() => client).close()).resolves.toEqual({
      warning: "closed by disconnect",
      err: refusal,
    });
  });

  it("answers a warning without an error for a client that was not connected", async () => {
    const client = stubClient("reconnecting");

    await expect(redisStage(() => client).close()).resolves.toEqual({
      warning: "closed by disconnect",
    });
  });

  it("says there was nothing to close before the client was opened", async () => {
    const stage = redisStage(() => undefined);

    expect(stage.name).toBe("redis");
    await expect(stage.close()).resolves.toBe(NOT_OPENED);
  });
});

describe("the factories", () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it("keeps the options BullMQ needs on the queue client", () => {
    client = createQueueRedis(CLOSED_REDIS_URL);

    expect(client.options.maxRetriesPerRequest).toBeNull();
    expect(client.options.enableOfflineQueue).toBe(true);
    expect(client.options.connectTimeout).toBe(5_000);
    // Backoff grows with the attempt and stops at its cap.
    expect(client.options.retryStrategy?.(1)).toBe(200);
    expect(client.options.retryStrategy?.(10)).toBe(2_000);
    expect(client.options.retryStrategy?.(100)).toBe(5_000);
  });

  it("has no way to loosen the connection BullMQ uses", () => {
    // Only a logger: a retry limit or a reconnect policy passed to this
    // factory would reach the queues' connection without a word.
    expectTypeOf<keyof QueueRedisOptions>().toEqualTypeOf<"log">();
  });

  it("refuses at once on the client of requests, within the caller's bound", () => {
    client = createRequestRedis(CLOSED_REDIS_URL, { commandTimeoutMs: 1_234 });

    expect(client.options.enableOfflineQueue).toBe(false);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.commandTimeout).toBe(1_234);
    expect(client.options.connectTimeout).toBe(1_000);
    expect(client.options.retryStrategy?.(100)).toBe(2_000);
  });

  it("gives up at once on the probe client instead of waiting for Redis", () => {
    client = createProbeRedis(CLOSED_REDIS_URL, { connectTimeoutMs: 3_000 });

    expect(client.options.connectTimeout).toBe(3_000);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.retryStrategy?.(1)).toBeNull();
  });

  it("takes nothing but the connect timeout for the probe client", () => {
    // The healthcheck reads its verdict from the rejection of `get`; an option
    // nobody passes is a branch nobody runs.
    expectTypeOf<keyof ProbeRedisOptions>().toEqualTypeOf<"connectTimeoutMs">();
  });

  it.each([
    ["queue", () => createQueueRedis(CLOSED_REDIS_URL)],
    [
      "request",
      () => createRequestRedis(CLOSED_REDIS_URL, { commandTimeoutMs: 1_000 }),
    ],
    [
      "probe",
      () => createProbeRedis(CLOSED_REDIS_URL, { connectTimeoutMs: 1_000 }),
    ],
  ])(
    "survives a connection failure of the %s client instead of taking the process down",
    (_kind, open: () => Redis) => {
      // An `error` event without a listener is rethrown by `EventEmitter`.
      client = open();

      expect(client.listenerCount("error")).toBeGreaterThan(0);
      expect(() =>
        client?.emit("error", new Error("connect ECONNREFUSED")),
      ).not.toThrow();
    },
  );

  it("fades the outages of the client of requests the way the queue client does", () => {
    // It reconnects every couple of seconds while Redis is down: a fixed
    // `error` per attempt would bury the rest of the log of the api.
    const { log, lines, levels } = recordingLogger();
    client = createRequestRedis(CLOSED_REDIS_URL, {
      commandTimeoutMs: 1_000,
      log,
    });

    // Synchronous, so the refusals of port 1 cannot come in between.
    for (let i = 0; i < 6; i += 1) {
      client.emit("error", new Error("connect ECONNREFUSED"));
    }
    client.emit("ready");

    expect(levels()).toEqual([
      "error",
      "warn",
      "warn",
      "warn",
      "warn",
      "debug",
      "info",
    ]);
    expect(lines.at(-1)?.msg).toBe("redis connection ready");
  });

  it("writes the outages of the queue client to the logger it is given", () => {
    const { log, lines } = recordingLogger();
    client = createQueueRedis(CLOSED_REDIS_URL, { log });

    client.emit("error", new Error("connect ECONNREFUSED"));
    client.emit("ready");

    expect(lines.map((line) => line.msg)).toEqual([
      "redis client error",
      "redis connection ready",
    ]);
  });
});
