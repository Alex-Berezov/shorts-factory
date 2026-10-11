import { type BuildLabelName, type Env, buildLimits } from "@sf/config";
import type { BuildInfo } from "@sf/contracts";
import { closeDb, createDb } from "@sf/db";
import type { FastifyBaseLogger } from "fastify";
import { type AppInstance, buildApp } from "./app.js";
import { createBudgetProbe } from "./lib/budget.js";
import { createHealthProbes } from "./lib/health.js";
import { createWorkerProbe } from "./lib/heartbeat.js";
import { createQueueStats } from "./lib/queue-stats.js";
import { type ClosableRedis, closeRedis, createRedis } from "./lib/redis.js";
import { type ShutdownTarget, createShutdownHandler } from "./lib/shutdown.js";

export interface ComposeOptions {
  /**
   * The process logger, built before this is called: every connection below
   * reports its failures to it from the moment it is opened, and `buildApp`
   * gets the same instance instead of building a second one.
   */
  log: FastifyBaseLogger;
  /**
   * The build labels `@sf/config` read as unset because they were not labels
   * (`rejectedBuildLabels()`), passed in so that composing stays a function
   * of its arguments.
   */
  rejectedBuildLabels: readonly BuildLabelName[];
  /** Seam for tests: the Redis client factory. */
  createRedis?: typeof createRedis;
  /** Seam for tests: the factory of the queue counters. */
  createQueueStats?: typeof createQueueStats;
  /** Seam for tests; the process really does exit in production. */
  exit?: (code: number) => void;
}

export interface ComposedApp {
  app: AppInstance;
  /** Signal handler: closes the app and the connections, then exits. */
  shutdown: (signal: string) => Promise<void>;
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
 * The Redis client as a target of the shutdown. A socket torn down after a
 * refused QUIT is still a closed client (`closeRedis`), so it is no failure of
 * the stop - but it is not a QUIT either, and the line of the stop says so.
 */
function redisTarget(client: ClosableRedis): ShutdownTarget {
  return {
    close: async () => {
      const outcome = await closeRedis(client);
      return outcome.kind === "disconnected"
        ? { warning: "closed by disconnect", err: outcome.err }
        : undefined;
    },
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
 */
export function composeApp(env: Env, options: ComposeOptions): ComposedApp {
  const { log } = options;
  const openRedis = options.createRedis ?? createRedis;
  const openQueueStats = options.createQueueStats ?? createQueueStats;

  for (const variable of options.rejectedBuildLabels) {
    // The name only: the value is whatever the build system passed.
    log.warn({ variable }, "build label ignored");
  }

  const db = createDb(env.DATABASE_URL);
  // The client survives a Redis that is down on its own (`createRedis`
  // subscribes to `error` itself); this callback only decides where such a
  // failure is written.
  const redis = openRedis(env.REDIS_URL, {
    onError: (err) => {
      log.error({ err }, "redis client error");
    },
  });

  // The `Queue` objects live for the process, not for the request: each one is
  // a set of listeners and a key of its own, and opening 29 of them per call
  // to `/system/status` would make the page the most expensive route of the
  // api. Their failures are not written here: the client above writes its
  // own, and a refused pass is in the answer of the page (`redis: down`).
  const queueStats = openQueueStats({ connection: redis });

  const app = buildApp(
    {
      health: createHealthProbes({ db, redis }),
      buildInfo: buildInfoFrom(env),
      queues: queueStats,
      worker: createWorkerProbe({ redis }),
      // No cache here on purpose: a request that joins a read in flight gets
      // the state as of the start of that read - one read behind at most,
      // nothing kept.
      budget: createBudgetProbe({ db, limits: buildLimits(env) }),
    },
    { adminPassword: env.ADMIN_PASSWORD, logger: log },
  );

  const shutdown = createShutdownHandler({
    app,
    db: { close: () => closeDb(db) },
    // Before Redis: the queues are closed through the connection they share
    // with it, and a client that is already gone leaves them hanging.
    queues: { close: () => queueStats.close() },
    redis: redisTarget(redis),
    log: app.log,
    ...(options.exit === undefined ? {} : { exit: options.exit }),
  });

  return { app, shutdown };
}
