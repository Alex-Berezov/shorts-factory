import { type Env, loadEnv } from "@sf/config";
import { QUEUE_NAMES } from "@sf/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInfoFrom, composeApp } from "../src/compose-app.js";
import { buildLoggerOptions } from "../src/lib/logger.js";
import { type QueueStats, createQueueStats } from "../src/lib/queue-stats.js";
import { createRedis } from "../src/lib/redis.js";
import { dependencyFailureCode } from "../src/lib/system-status.js";
import { type Recorder, recordingLogger } from "./recording-logger.js";

/**
 * Nothing listens on port 1. The database client does not connect until it is
 * asked something, and no case here asks it. Redis is `idleRedis` below by
 * default; a case that passes the real `createRedis` does reach for port 1 and
 * is refused, and its client keeps reconnecting until the shutdown that
 * `compose` registers for every case closes it.
 */
const CLOSED_REDIS_URL = "redis://127.0.0.1:1";
const CLOSED_DATABASE_URL = "postgres://sf:sf@127.0.0.1:1/shorts_factory_none";

/** The message of the failure the fake factory reports before returning. */
const STARTUP_FAILURE = "refused while the api was still being composed";

/** A parsed config, built the way the service builds it. */
function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: CLOSED_DATABASE_URL,
    REDIS_URL: CLOSED_REDIS_URL,
    ADMIN_PASSWORD: "testtest",
    ...overrides,
  });
}

/** A recorder on the options the service builds its logger from. */
function recordingLog(env: Env): Recorder {
  const { transport: _unused, ...options } = buildLoggerOptions(env);
  return recordingLogger(options);
}

/**
 * A Redis client that never connects on its own (`lazyConnect`), wired to
 * `onError` the way `createRedis` wires it. Nothing in `composeApp` sends it
 * a command; the shutdown closes it without ever reaching the server.
 */
const idleRedis: typeof createRedis = (url, options) => {
  const client = new Redis(url, { lazyConnect: true });
  client.on("error", (err: Error) => {
    options?.onError?.(err);
  });
  return client;
};

/** Shutdowns to run after each case, so no client outlives its test. */
const pending: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of pending.splice(0)) {
    await stop();
  }
});

/** `composeApp` with the exit seam taken and the cleanup registered. */
function compose(
  env: Env,
  options: Omit<Parameters<typeof composeApp>[1], "exit">,
): ReturnType<typeof composeApp> {
  const composed = composeApp(env, {
    createRedis: idleRedis,
    ...options,
    exit: () => {},
  });
  pending.push(() => composed.shutdown("SIGTERM"));
  return composed;
}

describe("buildInfoFrom", () => {
  it("puts the version and the commit where they belong", () => {
    expect(
      buildInfoFrom({ APP_VERSION: "1.4.0", GIT_COMMIT: "abc1234" }),
    ).toEqual({ version: "1.4.0", commit: "abc1234" });
  });

  it("says null for each field that is absent, on its own", () => {
    expect(
      buildInfoFrom({ APP_VERSION: "1.4.0", GIT_COMMIT: undefined }),
    ).toEqual({ version: "1.4.0", commit: null });
    expect(
      buildInfoFrom({ APP_VERSION: undefined, GIT_COMMIT: "abc1234" }),
    ).toEqual({ version: null, commit: "abc1234" });
    expect(
      buildInfoFrom({ APP_VERSION: undefined, GIT_COMMIT: undefined }),
    ).toEqual({ version: null, commit: null });
  });
});

describe("composeApp", () => {
  it("writes a Redis failure raised before the app exists", () => {
    const env = envWith();
    const { log, raw } = recordingLog(env);

    // The failure is reported from inside the factory, before `buildApp` has
    // run: a callback that waits for the app logger has nowhere to write it.
    compose(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: (url, options) => {
        options?.onError?.(new Error(STARTUP_FAILURE));
        return idleRedis(url, options);
      },
    });

    const written = raw();
    expect(written).toContain("redis client error");
    expect(written).toContain(STARTUP_FAILURE);
  });

  /**
   * Redis is down and the status page reads the queues: every `Queue` of the
   * pass fails its `init()` and reports it as an `error` event. The refusal is
   * the answer of the pass (`redis: down`), and the client writes its own
   * failure; a line per queue on top of that would be 29 error lines per poll.
   * The pass is run on the collector the wiring built, not through the page,
   * so that the database of the page stays out of the case.
   */
  it("writes no error line per queue when a pass meets a Redis that is down", async () => {
    const env = envWith();
    const { log, entries } = recordingLog(env);
    const built: QueueStats[] = [];
    compose(env, {
      log,
      rejectedBuildLabels: [],
      createRedis,
      createQueueStats: (options) => {
        const stats = createQueueStats(options);
        built.push(stats);
        return stats;
      },
    });

    const [stats] = built;
    if (stats === undefined) {
      throw new Error("the wiring built no queue stats");
    }
    // A refused `Queue` reports its `error` before the pass drops it with a
    // `close()`, so 29 closes mean every queue of the pass has spoken.
    const closes = vi.spyOn(Queue.prototype, "close");
    try {
      const failure = await stats.collect().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(dependencyFailureCode(failure)).toBe("unreachable");

      await vi.waitFor(() => {
        expect(closes).toHaveBeenCalledTimes(QUEUE_NAMES.length);
        expect(
          entries().some((entry) => entry.msg === "redis client error"),
        ).toBe(true);
      });
    } finally {
      closes.mockRestore();
    }

    const errors = entries().filter(
      (entry) =>
        typeof entry.level === "number" &&
        entry.level >= 50 &&
        entry.msg !== "redis client error",
    );
    expect(errors).toEqual([]);
  });

  it("names a build label the config dropped, without its value", () => {
    const env = envWith();
    const { log, entries } = recordingLog(env);

    compose(env, { log, rejectedBuildLabels: ["APP_VERSION"] });

    const warning = entries().find(
      (entry) => entry.msg === "build label ignored",
    );
    expect(warning).toMatchObject({ level: 40, variable: "APP_VERSION" });
  });

  it("says nothing about the build labels when none was dropped", () => {
    const env = envWith();
    const { log, raw } = recordingLog(env);

    compose(env, { log, rejectedBuildLabels: [] });

    expect(raw()).not.toContain("build label ignored");
  });

  it("runs the app on the logger it was given, redact paths and all", () => {
    const env = envWith();
    const { log, raw } = recordingLog(env);
    const { app } = compose(env, { log, rejectedBuildLabels: [] });

    // The shape ioredis gives the error of a failed `AUTH`: the command it
    // was running, password included. pino's error serializer keeps every
    // own property, so only `redact` stands between it and the line.
    app.log.error(
      {
        err: Object.assign(new Error("auth failed"), {
          command: { name: "auth", args: ["c2VjcmV0LXZhbHVl"] },
        }),
      },
      "redis command failed",
    );

    const written = raw();
    expect(written).toContain("redis command failed");
    expect(written).not.toContain("c2VjcmV0LXZhbHVl");
  });

  it("serializes a request the way Fastify does, with a logger of ours", () => {
    const env = envWith();
    const { log, entries } = recordingLog(env);
    const { app } = compose(env, { log, rejectedBuildLabels: [] });

    // Handed an instance, Fastify still puts its `req` serializer on the
    // logger it derives from it: a request object is written as its five
    // fields, not dumped with its headers and socket.
    app.log.info(
      {
        req: {
          method: "GET",
          url: "/system/status",
          headers: { authorization: "Basic c2VjcmV0LXZhbHVl" },
          socket: { remotePort: 4242 },
        },
      },
      "request dumped",
    );

    const entry = entries().find((e) => e.msg === "request dumped");
    expect(entry?.req).toEqual({
      method: "GET",
      url: "/system/status",
      remotePort: 4242,
    });
  });

  /**
   * Redis is down at the stop: the client of the api refuses the QUIT (no
   * offline queue) and the socket is torn down instead. The stop is clean and
   * says how Redis went - the wiring, not a stub, decides that.
   */
  it("stops cleanly with a warning when Redis is down at the stop", async () => {
    const env = envWith();
    const { log, entries } = recordingLog(env);
    const codes: number[] = [];
    const { shutdown } = composeApp(env, {
      log,
      rejectedBuildLabels: [],
      createRedis,
      exit: (code) => codes.push(code),
    });
    pending.push(() => shutdown("SIGTERM"));

    await shutdown("SIGTERM");

    const redisLines = entries().filter((entry) => entry.target === "redis");
    expect(redisLines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: "closed by disconnect",
        err: expect.objectContaining({
          message:
            "Stream isn't writeable and enableOfflineQueue options is false",
        }),
      }),
    ]);
    expect(codes).toEqual([0]);
  });
});
