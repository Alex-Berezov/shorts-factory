import { type Env, loadEnv } from "@sf/config";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { buildInfoFrom, composeApp } from "../src/compose-app.js";
import { buildLoggerOptions } from "../src/lib/logger.js";
import { createQueueStats } from "../src/lib/queue-stats.js";
import type { createRedis } from "../src/lib/redis.js";
import { type Recorder, recordingLogger } from "./recording-logger.js";

/**
 * Nothing listens on port 1. No case here needs a connection: the database
 * client does not connect until it is asked something, and Redis is
 * `idleRedis` below, so a case that fails before its cleanup leaves no socket
 * reconnecting behind it to keep the run alive.
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

  it("writes a failure of a queue the status page reads", () => {
    const env = envWith();
    const { log, entries } = recordingLog(env);

    compose(env, {
      log,
      rejectedBuildLabels: [],
      createQueueStats: (options) => {
        options.onError?.("system.dlq", new Error(STARTUP_FAILURE));
        return createQueueStats(options);
      },
    });

    const entry = entries().find((e) => e.msg === "queue error");
    expect(entry).toMatchObject({
      level: 50,
      queue: "system.dlq",
      err: { message: STARTUP_FAILURE },
    });
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
});
