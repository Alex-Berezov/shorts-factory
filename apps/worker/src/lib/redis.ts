import { Redis } from "ioredis";
import type { Logger } from "pino";

/** How long a connect attempt is given before it is treated as a failure. */
const CONNECT_TIMEOUT_MS = 5_000;
/** Upper bound of the reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 5_000;
/** How many repeats of the same outage are still worth a `warn`. */
const WARN_UNTIL_OCCURRENCE = 5;

/**
 * Redis client for the worker process, and deliberately not the one in
 * `apps/api/src/lib/redis.ts`: BullMQ needs the opposite options.
 *
 * - `maxRetriesPerRequest: null` is required by BullMQ - a blocking `BRPOPLPUSH`
 *   that ioredis gives up on would make the worker drop a job it is holding;
 * - the offline queue stays on for the same reason: a command issued during a
 *   reconnect has to wait for the socket rather than fail, otherwise every
 *   reconnect turns into a batch of failed jobs;
 * - the reconnect backoff is capped so that a long outage does not become a
 *   tight loop.
 *
 * The price of the first two options is that a command to a Redis that is down
 * waits forever. That is why the shutdown of this process has a deadline of
 * its own (`lib/shutdown.ts`) and why the failures below are logged: a worker
 * that is hanging on a dead Redis must say so, since it looks exactly like a
 * worker with nothing to do.
 *
 * A duplicate of the api factory on purpose (docs/TECH_DEBT.md, 08.09.2026):
 * the two differ in every option that matters. A third consumer is the point
 * at which this moves into a package.
 *
 * The `error` listener is attached here, not left to the caller: ioredis
 * reports connection failures as events, and an `EventEmitter` error without a
 * listener takes the process down - with every job it is running.
 */
export interface WorkerRedisOptions {
  /**
   * Reports outages at a level that fades and says when the client came back
   * (see `createRedisHealthListeners`). Every entry point passes it; a fixture
   * that only needs a connection may leave it out, and the failures are then
   * swallowed by the listener that keeps the process alive.
   */
  log?: Logger;
}

export function createRedis(
  url: string,
  options: WorkerRedisOptions = {},
): Redis {
  const client = new Redis(url, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Required by BullMQ: see the comment above before changing either line.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (attempt: number) =>
      Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });

  const health =
    options.log === undefined
      ? undefined
      : createRedisHealthListeners(options.log);
  client.on("error", (err: Error) => {
    health?.onError(err);
  });
  if (health !== undefined) {
    client.on("ready", health.onReady);
  }

  return client;
}

/** The levels an outage is reported at, in the order it walks down them. */
export type RedisErrorLevel = "error" | "warn" | "debug";

/**
 * Which level the n-th failure of one outage deserves. ioredis retries a dead
 * Redis every few hundred milliseconds and emits an `error` every time, so a
 * fixed `error` level buries everything else in the log within a minute -
 * including the line that says the worker went down.
 *
 * The first failure keeps `error`: that is the one an operator must see. The
 * next few stay visible at `warn` (a reconnect that is taking longer than a
 * blip), and after that the same outage is only worth a counter at `debug`.
 */
export function redisErrorLevel(occurrence: number): RedisErrorLevel {
  if (occurrence <= 1) {
    return "error";
  }
  return occurrence <= WARN_UNTIL_OCCURRENCE ? "warn" : "debug";
}

/** Counts one outage and writes it at a level that fades as it repeats. */
export interface RedisErrorReporter {
  report(err: Error): void;
  /** Called when the client is usable again: the next outage is news again. */
  reset(): void;
}

export function createRedisErrorReporter(log: Logger): RedisErrorReporter {
  let occurrence = 0;
  return {
    report(err: Error): void {
      occurrence += 1;
      const level = redisErrorLevel(occurrence);
      log[level]({ err, occurrence }, "redis client error");
    },
    reset(): void {
      occurrence = 0;
    },
  };
}

/** The two things every entry point does with the health of its client. */
export interface RedisHealthListeners {
  onError(err: Error): void;
  onReady(): void;
}

/**
 * The wiring an entry point used to build by hand, and built differently in
 * each one: an outage is reported at a level that fades, and a reconnect makes
 * the next outage news again - and says so, because with the levels fading
 * this is the only line that reports recovery.
 *
 * Attached by `createRedis` when it is given a logger, so that a second entry
 * point (the smoke CLI, the DLQ replay of E13-02) cannot get half of it.
 */
export function createRedisHealthListeners(log: Logger): RedisHealthListeners {
  const reporter = createRedisErrorReporter(log);
  return {
    onError: (err: Error): void => {
      reporter.report(err);
    },
    onReady: (): void => {
      reporter.reset();
      log.info("redis connection ready");
    },
  };
}

/** The part of the Redis client a shutdown uses. */
export interface ClosableRedis {
  /** ioredis connection state: "ready" only when a command can be written. */
  readonly status: string;
  quit(): Promise<unknown>;
  disconnect(): void;
}

/**
 * Closes the client for good, whether or not it was ever connected.
 *
 * A client that is not `ready` is torn down instead of being asked to `quit`,
 * and this is where the worker parts from the api: with the offline queue on
 * and `maxRetriesPerRequest: null`, a `QUIT` issued while the socket is down
 * is not rejected - it waits in the queue for a reconnect that may never come,
 * and the shutdown would hang until its deadline and exit with 1. A stop
 * during a Redis outage is a clean stop: the client is gone either way, which
 * is all a shutdown asked for. The `catch` covers the same answer arriving as
 * a rejection when the socket dies mid-`quit`.
 */
export async function closeRedis(client: ClosableRedis): Promise<void> {
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
