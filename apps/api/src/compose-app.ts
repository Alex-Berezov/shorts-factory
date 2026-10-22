import { type BuildLabelName, type Env, buildLimits } from "@sf/config";
import type { BuildInfo } from "@sf/contracts";
import {
  type ShutdownHandler,
  createRequestRedis,
  createShutdownHandler,
  redisStage,
  stageOf,
  subscribeToSignals,
} from "@sf/runtime";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { buildApp } from "./app.js";
import type { AppInstance } from "./lib/app-instance.js";
import { createBudgetProbe } from "./lib/budget.js";
import { DEPENDENCY_TIMEOUT_MS } from "./lib/dependency-timeout.js";
import { createHealthProbes } from "./lib/health.js";
import { createWorkerProbe } from "./lib/heartbeat.js";
import { type ProbeDbs, openProbeDbs } from "./lib/probe-dbs.js";
import { type QueueStats, createQueueStats } from "./lib/queue-stats.js";

/**
 * How long the stop gets before the process is torn down anyway: Fastify
 * drains the requests in flight, and a request is bounded by
 * `DEPENDENCY_TIMEOUT_MS` per dependency call.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ComposeOptions {
  /**
   * The process logger, built before this is called: every connection below
   * reports its failures to it from the moment it is opened, `buildApp` gets
   * the same instance instead of building a second one, and the stop flushes
   * it before the exit.
   */
  log: Logger;
  /**
   * The build labels `@sf/config` read as unset because they were not labels
   * (`rejectedBuildLabels`, from the same snapshot of the environment as `env`),
   * passed in so that composing stays a function of its arguments.
   */
  rejectedBuildLabels: readonly BuildLabelName[];
  /** Seam for tests: the Redis client factory. */
  createRedis?: typeof createRequestRedis;
  /** Seam for tests: the factory of the queue counters. */
  createQueueStats?: typeof createQueueStats;
  /** Seam for tests; the process really does exit in production. */
  exit?: (code: number) => void;
  /**
   * Seam for tests; production listens for SIGINT and SIGTERM. Called before
   * anything is opened, so that a signal during a compose that fails - while
   * its stop is closing what it opened - reaches that stop instead of Node's
   * default action, which ends the process on the spot with the connections
   * still open.
   */
  subscribe?: (handler: (signal: string) => void) => void;
}

/**
 * A compose that failed and has been dealt with: `composeApp` wrote why and
 * handed what it opened to its stop, which exits with 1 when it is done. The
 * original failure is the `cause`.
 */
export class ComposeFailure extends Error {
  constructor(cause: unknown) {
    super("composing the api failed", { cause });
    this.name = "ComposeFailure";
  }
}

export interface ComposedApp {
  app: AppInstance;
  /**
   * Closes the app and the connections, then exits: the handler of the
   * signals, and of a start that failed after this returned (`failed: true`,
   * a port that was taken).
   */
  shutdown: ShutdownHandler;
}

/**
 * The build fingerprint `/system/status` reports, from the two config fields
 * that carry it. Absent is `null`, field by field: a build that knows its
 * version but not its commit says exactly that.
 */
export function buildInfoFrom(
  env: Pick<Env, "APP_VERSION" | "GIT_COMMIT">,
): BuildInfo {
  return {
    version: env.APP_VERSION ?? null,
    commit: env.GIT_COMMIT ?? null,
  };
}

/**
 * Everything the entry point owns except the socket and the signals: the
 * connections, the collectors on top of them, the application and the
 * shutdown that closes them in order. A function rather than top-level code in
 * `server.ts`, so the wiring - which logger a failure reaches, which config
 * field becomes which part of `/system/status` - is under test instead of
 * being checked by eye after a deploy.
 *
 * The logger comes first and from outside. A connection failure is an event
 * that can fire as soon as the client exists, and the callbacks below write
 * straight to the logger instead of to a placeholder that `buildApp` would
 * fill in later.
 *
 * The stop exists and listens for the signals before anything is opened: a
 * compose that fails halfway writes why, closes what it opened through the
 * same stop, with `failed: true`, and then throws a `ComposeFailure` - the
 * stop exits the process when it is done, so the caller has nothing left to
 * close. A target the compose never reached is written as not opened rather
 * than as closed.
 */
export function composeApp(env: Env, options: ComposeOptions): ComposedApp {
  const { log } = options;
  const openRedis = options.createRedis ?? createRequestRedis;
  const openQueueStats = options.createQueueStats ?? createQueueStats;

  // Assigned below; the stages read them when the stop runs, which may be
  // before any of them exists.
  let db: ProbeDbs | undefined;
  let redis: Redis | undefined;
  let queueStats: QueueStats | undefined;
  let app: AppInstance | undefined;

  const shutdown = createShutdownHandler({
    plan: [
      // Fastify first: it stops accepting and drains the requests in flight,
      // which still need their connections.
      stageOf(
        "app",
        () => app,
        (opened) => opened.close(),
      ),
      // Then two branches at once, because nothing in one waits for the
      // other: the driver on its own, and the queue objects followed by the
      // Redis client they run on - BullMQ ends its own reads through that
      // client, and a socket torn down first leaves them waiting for a reply
      // that cannot come.
      {
        parallel: [
          [
            stageOf(
              "db",
              () => db,
              (opened) => opened.close(),
            ),
          ],
          [
            stageOf(
              "queues",
              () => queueStats,
              (opened) => opened.close(),
            ),
            redisStage(() => redis),
          ],
        ],
      },
    ],
    log,
    startedMessage: "shutdown started",
    // A request in flight loses nothing to a slow stop, and Compose only
    // ever sends SIGTERM: a second Ctrl+C is told about, not obeyed (Р3,
    // E0-12B).
    repeatedSigint: "log",
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    ...(options.exit === undefined ? {} : { exit: options.exit }),
  });
  (options.subscribe ?? subscribeToSignals)((signal) => {
    void shutdown(signal);
  });

  try {
    for (const variable of options.rejectedBuildLabels) {
      // The name only: the value is whatever the build system passed.
      log.warn({ variable }, "build label ignored");
    }

    // The api reads the database through its probes only, each on a handle
    // of its own (`openProbeDbs`).
    const databases = openProbeDbs(env.DATABASE_URL, log);
    db = databases;
    // The client survives a Redis that is down on its own (the factory
    // subscribes to `error` itself); the logger makes it report the outage
    // at a level that fades and say when it is back.
    const client = openRedis(env.REDIS_URL, {
      commandTimeoutMs: DEPENDENCY_TIMEOUT_MS,
      log,
    });
    redis = client;

    // The `Queue` objects live for the process, not for the request: each one
    // is a set of listeners and a key of its own, and opening 29 of them per
    // call to `/system/status` would make the page the most expensive route
    // of the api. Their connection failures are not written here: the client
    // above writes its own, and a refused pass is in the answer of the page
    // (`redis: down`).
    const stats = openQueueStats({ connection: client, log });
    queueStats = stats;

    app = buildApp(
      {
        health: createHealthProbes({ db: databases.health, redis: client }),
        buildInfo: buildInfoFrom(env),
        queues: stats,
        worker: createWorkerProbe({ redis: client }),
        // No cache here on purpose: a request that joins a read in flight
        // gets the state as of the start of that read - one read behind at
        // most, nothing kept. The limits are those of the `env` this was
        // given, not the `limits` of `@sf/config`: a test composes with an
        // `env` of its own, and the caps it reads have to be the ones in it.
        budget: createBudgetProbe({
          db: databases.budget,
          limits: buildLimits(env),
        }),
      },
      { adminPassword: env.ADMIN_PASSWORD, logger: log },
    );
    return { app, shutdown };
  } catch (err) {
    log.fatal({ err }, "api failed to start");
    void shutdown("startup failure", { failed: true });
    throw new ComposeFailure(err);
  }
}

/**
 * `composeApp` for the entry point, which has nobody to throw to. A
 * `ComposeFailure` is already written and in the hands of its stop, which
 * exits; anything else was thrown before `composeApp` opened a thing - by
 * the arguments of the call, or ahead of its stop - and nobody has written
 * it yet: it gets its `fatal` line here, and `fail` gives the process the
 * code of a failure. Either way there is no app to start.
 */
export function composeOrFail(
  compose: () => ComposedApp,
  log: Pick<Logger, "fatal">,
  fail: () => void,
): ComposedApp | undefined {
  try {
    return compose();
  } catch (err) {
    if (!(err instanceof ComposeFailure)) {
      log.fatal({ err }, "api failed to start");
      fail();
    }
    return undefined;
  }
}
