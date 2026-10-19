import { type Env, loadEnv } from "@sf/config";
import { QUEUE_NAMES } from "@sf/core";
import { createRequestRedis } from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposeFailure,
  type ComposedApp,
  buildInfoFrom,
  composeApp,
  composeOrFail,
} from "../src/compose-app.js";
import { type QueueStats, createQueueStats } from "../src/lib/queue-stats.js";
import { dependencyFailureCode } from "../src/lib/system-status.js";
import { recordingServiceLogger } from "./helpers.js";

/**
 * Nothing listens on port 1. The database client does not connect until it is
 * asked something, and no case here asks it. Redis is `idleRedis` below by
 * default; a case that passes the real `createRequestRedis` does reach for port 1 and
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

/**
 * A Redis client that never connects on its own (`lazyConnect`), writing its
 * failures to the logger it is given, the way the first failure of an outage
 * is written by `createRequestRedis`. Nothing in `composeApp` sends it a
 * command; the shutdown closes it without ever reaching the server.
 */
const idleRedis: typeof createRequestRedis = (url, options) => {
  const client = new Redis(url, { lazyConnect: true });
  client.on("error", (err: Error) => {
    options.log?.error({ err }, "redis client error");
  });
  return client;
};

/** The signals of a case are its own: nothing is subscribed on the process. */
const noSignals = (): void => {};

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
    subscribe: noSignals,
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
    const { log, raw } = recordingServiceLogger(env);

    // The failure is reported from inside the factory, before `buildApp` has
    // run: a callback that waits for the app logger has nowhere to write it.
    compose(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: (url, options) => {
        const client = idleRedis(url, options);
        client.emit("error", new Error(STARTUP_FAILURE));
        return client;
      },
    });

    const written = raw();
    expect(written).toContain("redis client error");
    expect(written).toContain(STARTUP_FAILURE);
  });

  it("fades the outages of its Redis client instead of an error per attempt", () => {
    // The client of requests reconnects every couple of seconds while Redis
    // is down; the wiring hands it the logger, and the client fades.
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    let opened: Redis | undefined;
    compose(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: (url, options) => {
        opened = createRequestRedis(url, options);
        return opened;
      },
    });

    // Synchronous, so the refusals of port 1 cannot come in between.
    for (let i = 0; i < 6; i += 1) {
      opened?.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:1"));
    }

    // The sixth is at `debug`, below the level of the service.
    expect(
      entries()
        .filter((entry) => entry.msg === "redis client error")
        .map((entry) => entry.level),
    ).toEqual(["error", "warn", "warn", "warn", "warn"]);
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
    const { log, entries } = recordingServiceLogger(env);
    const built: QueueStats[] = [];
    compose(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: createRequestRedis,
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

      // A bound of its own, not the 1 s default: on an idle machine the 29
      // closes and the line of the client are in within 6-11 ms (ten runs),
      // and a loaded runner must not turn that into a red run.
      await vi.waitFor(
        () => {
          expect(closes).toHaveBeenCalledTimes(QUEUE_NAMES.length);
          expect(
            entries().some((entry) => entry.msg === "redis client error"),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
    } finally {
      closes.mockRestore();
    }

    const errors = entries().filter(
      (entry) =>
        (entry.level === "error" || entry.level === "fatal") &&
        entry.msg !== "redis client error",
    );
    expect(errors).toEqual([]);
  });

  it("names a build label the config dropped, without its value", () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);

    compose(env, { log, rejectedBuildLabels: ["APP_VERSION"] });

    const warning = entries().find(
      (entry) => entry.msg === "build label ignored",
    );
    expect(warning).toMatchObject({ level: "warn", variable: "APP_VERSION" });
  });

  it("says nothing about the build labels when none was dropped", () => {
    const env = envWith();
    const { log, raw } = recordingServiceLogger(env);

    compose(env, { log, rejectedBuildLabels: [] });

    expect(raw()).not.toContain("build label ignored");
  });

  it("runs the app on the logger it was given, redact paths and all", () => {
    const env = envWith();
    const { log, raw } = recordingServiceLogger(env);
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
    const { log, entries } = recordingServiceLogger(env);
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
   * Redis is down at the stop: the client of the api is not connected, so it
   * is torn down without a QUIT - which would only be refused, there being no
   * offline queue. The stop is clean and says how Redis went - the wiring, not
   * a stub, decides that; there is no refusal to show, so the line has none.
   */
  it("stops cleanly with a warning when Redis is down at the stop", async () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    const codes: number[] = [];
    const { shutdown } = composeApp(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: createRequestRedis,
      subscribe: noSignals,
      exit: (code) => codes.push(code),
    });
    pending.push(() => shutdown("SIGTERM"));

    await shutdown("SIGTERM");

    const redisLines = entries().filter((entry) => entry.target === "redis");
    expect(redisLines).toEqual([
      expect.objectContaining({ level: "warn", msg: "closed by disconnect" }),
    ]);
    expect(redisLines[0]).not.toHaveProperty("err");
    expect(codes).toEqual([0]);
  });

  /**
   * The QUIT itself refused - the socket died between the status check and
   * the command: the stop tears the client down, stays clean, and the line
   * of the stop carries the refusal through the wiring of the api, not only
   * through `closeRedis` on its own (`packages/runtime/test/redis.test.ts`).
   */
  it("writes the refusal of a QUIT on the line of a clean stop", async () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    const codes: number[] = [];
    const refusal = new Error("Connection is closed.");
    const { shutdown } = composeApp(env, {
      log,
      rejectedBuildLabels: [],
      createRedis: (url, options) => {
        const client = idleRedis(url, options);
        // Connected as far as the stop can tell, and the QUIT refused.
        client.status = "ready";
        vi.spyOn(client, "quit").mockRejectedValue(refusal);
        return client;
      },
      subscribe: noSignals,
      exit: (code) => codes.push(code),
    });
    pending.push(() => shutdown("SIGTERM"));

    await shutdown("SIGTERM");

    const redisLines = entries().filter((entry) => entry.target === "redis");
    expect(redisLines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "closed by disconnect",
        err: expect.objectContaining({ message: "Connection is closed." }),
      }),
    ]);
    expect(codes).toEqual([0]);
  });

  /**
   * A compose that throws after the first connection is open: what it opened
   * is closed by the same stop as on a signal, and the process leaves with
   * the code of a failure instead of the code of a crash with sockets open.
   * What it never reached is said to be not opened, not closed.
   */
  it("closes what it opened and exits with 1 when composing fails halfway", async () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    const codes: number[] = [];

    let thrown: unknown;
    try {
      composeApp(env, {
        log,
        rejectedBuildLabels: [],
        createRedis: idleRedis,
        createQueueStats: () => {
          throw new Error(STARTUP_FAILURE);
        },
        subscribe: noSignals,
        exit: (code) => codes.push(code),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ComposeFailure);
    expect(thrown instanceof Error ? thrown.cause : undefined).toMatchObject({
      message: STARTUP_FAILURE,
    });

    await vi.waitFor(() => {
      expect(codes).toEqual([1]);
    });
    expect(
      entries().find((entry) => entry.msg === "api failed to start"),
    ).toMatchObject({ level: "fatal" });
    expect(targetsOf(entries(), "closed")).toEqual(["db"]);
    expect(targetsOf(entries(), "not opened, nothing to close").sort()).toEqual(
      ["app", "queues"],
    );
    expect(entries().find((entry) => entry.target === "redis")).toMatchObject({
      level: "warn",
      msg: "closed by disconnect",
    });
    expect(
      entries().find((entry) => entry.msg === "shutdown complete"),
    ).toMatchObject({ signal: "startup failure", failed: true });
  });

  it("says the client was not opened when Redis could not be created", async () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    const codes: number[] = [];

    expect(() =>
      composeApp(env, {
        log,
        rejectedBuildLabels: [],
        createRedis: () => {
          throw new Error(STARTUP_FAILURE);
        },
        subscribe: noSignals,
        exit: (code) => codes.push(code),
      }),
    ).toThrow(ComposeFailure);

    await vi.waitFor(() => {
      expect(codes).toEqual([1]);
    });
    expect(targetsOf(entries(), "closed")).toEqual(["db"]);
    expect(targetsOf(entries(), "not opened, nothing to close").sort()).toEqual(
      ["app", "queues", "redis"],
    );
  });

  /**
   * The signals are listened for before anything is opened: a SIGTERM while
   * a failed compose is closing what it opened reaches that stop, instead of
   * Node's default action, which would end the process on the spot with the
   * connections still open and the exit code of a kill.
   */
  it("hands a signal during the stop of a failed compose to that stop", async () => {
    const env = envWith();
    const { log, entries } = recordingServiceLogger(env);
    const codes: number[] = [];
    const events: string[] = [];
    let signal: (name: string) => void = () => {};

    expect(() =>
      composeApp(env, {
        log,
        rejectedBuildLabels: [],
        createRedis: (url, options) => {
          events.push("redis opened");
          return idleRedis(url, options);
        },
        createQueueStats: () => {
          throw new Error(STARTUP_FAILURE);
        },
        subscribe: (handler) => {
          events.push("subscribed");
          signal = handler;
        },
        exit: (code) => codes.push(code),
      }),
    ).toThrow(ComposeFailure);
    signal("SIGTERM");

    await vi.waitFor(() => {
      expect(codes).toEqual([1]);
    });
    expect(events).toEqual(["subscribed", "redis opened"]);
    expect(
      entries().find((entry) => entry.msg === "shutdown already in progress"),
    ).toMatchObject({ signal: "SIGTERM", failed: true });
  });
});

describe("composeOrFail", () => {
  it("hands back what composing returned", () => {
    const env = envWith();
    const composed: ComposedApp = compose(env, {
      log: recordingServiceLogger(env).log,
      rejectedBuildLabels: [],
    });
    const fail = vi.fn();

    expect(composeOrFail(() => composed, recordingLogger().log, fail)).toBe(
      composed,
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("writes a throw nobody wrote yet and fails the process", () => {
    // Thrown before `composeApp` opened a thing - by an argument of the
    // call - so no stop is coming to exit with 1.
    const { log, lines } = recordingLogger();
    const fail = vi.fn();

    const composed = composeOrFail(
      () => {
        throw new Error(STARTUP_FAILURE);
      },
      log,
      fail,
    );

    expect(composed).toBeUndefined();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "fatal",
        msg: "api failed to start",
        err: expect.objectContaining({ message: STARTUP_FAILURE }),
      }),
    ]);
  });

  it("leaves a failure composeApp already handed to its stop alone", () => {
    const { log, lines } = recordingLogger();
    const fail = vi.fn();

    const composed = composeOrFail(
      () => {
        throw new ComposeFailure(new Error(STARTUP_FAILURE));
      },
      log,
      fail,
    );

    expect(composed).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

/** The targets whose line has this message, in the order of the lines. */
function targetsOf(
  lines: ReadonlyArray<{ msg: string; target?: unknown }>,
  msg: string,
): unknown[] {
  return lines.filter((line) => line.msg === msg).map((line) => line.target);
}
