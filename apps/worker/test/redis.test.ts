import { describe, expect, it } from "vitest";
import {
  type ClosableRedis,
  closeRedis,
  createRedisErrorReporter,
  createRedisHealthListeners,
  redisErrorLevel,
} from "../src/lib/redis.js";
import { recordingLogger } from "./recording-logger.js";

/** Records how the client was asked to go away, and how it answered. */
function stubClient(
  status: string,
  quitFails = false,
): ClosableRedis & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    status,
    quit: async () => {
      calls.push("quit");
      if (quitFails) {
        throw new Error("Connection is closed.");
      }
      return "OK";
    },
    disconnect: () => {
      calls.push("disconnect");
    },
  };
}

describe("redisErrorLevel", () => {
  it("reports the first failure of an outage at error level", () => {
    expect(redisErrorLevel(1)).toBe("error");
  });

  it("fades a repeating outage to warn and then to debug", () => {
    // ioredis emits an `error` on every reconnect attempt, several times a
    // second: at a fixed level the log would bury everything else - including
    // the line that says the worker went down.
    expect(redisErrorLevel(2)).toBe("warn");
    expect(redisErrorLevel(5)).toBe("warn");
    expect(redisErrorLevel(6)).toBe("debug");
    expect(redisErrorLevel(500)).toBe("debug");
  });
});

describe("createRedisErrorReporter", () => {
  it("walks the levels down as the same outage repeats", () => {
    const { log, levels } = recordingLogger();
    const reporter = createRedisErrorReporter(log);

    for (let i = 0; i < 7; i += 1) {
      reporter.report(new Error("ECONNREFUSED"));
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

  it("makes the next outage news again after a reconnect", () => {
    const { log, levels } = recordingLogger();
    const reporter = createRedisErrorReporter(log);

    reporter.report(new Error("ECONNREFUSED"));
    reporter.report(new Error("ECONNREFUSED"));
    reporter.reset();
    reporter.report(new Error("ECONNREFUSED"));

    expect(levels()).toEqual(["error", "warn", "error"]);
  });
});

describe("createRedisHealthListeners", () => {
  it("reports an outage, then says the client is back", () => {
    // The wiring every entry point needs, in one place: built by hand it came
    // out different in each - the smoke CLI never subscribed the reset, so its
    // reporter stayed at `debug` for the rest of the run, whatever happened
    // next.
    const { log, lines, levels } = recordingLogger();
    const health = createRedisHealthListeners(log);

    health.onError(new Error("ECONNREFUSED"));
    health.onError(new Error("ECONNREFUSED"));
    health.onReady();
    health.onError(new Error("ECONNREFUSED"));

    expect(levels()).toEqual(["error", "warn", "info", "error"]);
    expect(lines[2]?.msg).toBe("redis connection ready");
  });
});

describe("closeRedis", () => {
  it("quits a connected client and leaves it at that", async () => {
    const client = stubClient("ready");

    await closeRedis(client);

    expect(client.calls).toEqual(["quit"]);
  });

  it("tears down a client that is not connected instead of queueing a QUIT", async () => {
    // The worker keeps the offline queue on and `maxRetriesPerRequest: null`,
    // so a QUIT issued while the socket is down waits for a reconnect that may
    // never come: the shutdown would hang to its deadline and exit with 1.
    const client = stubClient("reconnecting");

    await closeRedis(client);

    expect(client.calls).toEqual(["disconnect"]);
  });

  it("tears the socket down when a quit is refused", async () => {
    const client = stubClient("ready", true);

    await expect(closeRedis(client)).resolves.toBeUndefined();
    expect(client.calls).toEqual(["quit", "disconnect"]);
  });
});
