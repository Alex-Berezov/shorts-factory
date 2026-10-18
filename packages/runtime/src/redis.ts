import { Redis } from "ioredis";
import type { RuntimeLogger } from "./runtime-logger.js";
import { type CloseWarning, type ShutdownStage, stageOf } from "./shutdown.js";

/**
 * The Redis clients of every process: three factories, one per connection
 * policy, rather than one factory with options.
 *
 * The policies are opposites. BullMQ needs a client that waits - no request
 * retry limit and an offline queue, or a reconnect drops the job a worker is
 * holding. A request of the api needs a client that refuses at once while
 * Redis is down, or the page that reports the outage hangs in it. A one-shot
 * check needs a client that does not even reconnect. An option that loosens
 * the first into the second would reach the queues' connection through one
 * wrong object, so there is no such option: each policy is a function, and
 * the caller names the one it means.
 *
 * Every client gets its `error` listener inside its factory: ioredis reports
 * connection failures as events, and an `EventEmitter` error without a
 * listener takes the whole process down. Subscribing here leaves no window
 * between the socket opening and the caller subscribing.
 */

/** Upper bound of the reconnect backoff of a client that keeps reconnecting. */
const QUEUE_MAX_RECONNECT_DELAY_MS = 5_000;
/** How long a connect attempt of the queue client gets. */
const QUEUE_CONNECT_TIMEOUT_MS = 5_000;
/** The same two for the client of requests: a page has to answer quickly. */
const REQUEST_MAX_RECONNECT_DELAY_MS = 2_000;
const REQUEST_CONNECT_TIMEOUT_MS = 1_000;
/** How many repeats of the same outage are still worth a `warn`. */
const WARN_UNTIL_OCCURRENCE = 5;

/** What a client tells its owner about its health; both are optional. */
interface ClientListeners {
  onError?: (err: Error) => void;
  onReady?: () => void;
}

/** The `error` listener every client gets, and the rest when asked for. */
function withListeners(client: Redis, listeners: ClientListeners): Redis {
  client.on("error", (err: Error) => {
    listeners.onError?.(err);
  });
  if (listeners.onReady !== undefined) {
    client.on("ready", listeners.onReady);
  }
  return client;
}

/** The health reporting of a client given a logger, nothing without one. */
function healthOf(log: RuntimeLogger | undefined): ClientListeners {
  if (log === undefined) {
    return {};
  }
  const health = createRedisHealthListeners(log);
  return { onError: health.onError, onReady: health.onReady };
}

export interface QueueRedisOptions {
  /**
   * Reports outages at a level that fades and says when the client came back
   * (`createRedisHealthListeners`). Every entry point passes it; a fixture
   * that only needs a connection may leave it out, and the failures are then
   * swallowed by the listener that keeps the process alive.
   */
  log?: RuntimeLogger;
}

/**
 * The client BullMQ runs on - the worker's, and any process that adds jobs.
 *
 * - `maxRetriesPerRequest: null` is required by BullMQ: a blocking
 *   `BRPOPLPUSH` that ioredis gives up on would make the worker drop a job it
 *   is holding;
 * - the offline queue stays on for the same reason: a command issued during a
 *   reconnect waits for the socket rather than fail, otherwise every reconnect
 *   turns into a batch of failed jobs;
 * - the reconnect backoff is capped so that a long outage is not a tight loop.
 *
 * The price of the first two is that a command to a Redis that is down waits
 * forever. That is why the shutdown has a deadline of its own and why the
 * failures are logged: a worker hanging on a dead Redis looks exactly like a
 * worker with nothing to do, unless it says so.
 */
export function createQueueRedis(
  url: string,
  options: QueueRedisOptions = {},
): Redis {
  return withListeners(
    new Redis(url, {
      connectTimeout: QUEUE_CONNECT_TIMEOUT_MS,
      // Required by BullMQ: see the comment above before changing either line.
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      retryStrategy: (attempt: number) =>
        Math.min(attempt * 200, QUEUE_MAX_RECONNECT_DELAY_MS),
    }),
    healthOf(options.log),
  );
}

interface RequestRedisOptions {
  /**
   * How long a command sent down an open socket may go unanswered before it
   * fails by itself ("Command timed out"). The deadline of a request gives up
   * on such a command without ending it; without this bound every poll would
   * leave one more behind. The caller passes its own deadline.
   */
  commandTimeoutMs: number;
  /**
   * The same health reporting as the queue client's: an outage at a level
   * that fades, a reconnect that says so. The client of requests reconnects
   * every couple of seconds while Redis is down, and an `error` line per
   * attempt would bury the rest of the log. Every entry point passes it; a
   * fixture may leave it out.
   */
  log?: RuntimeLogger;
}

/**
 * The client of a process that answers requests - the api, which only reads.
 * Every option trades throughput for a fast, honest failure:
 *
 * - `enableOfflineQueue: false` - a command issued while the socket is down
 *   fails instead of waiting for a reconnect that may never come;
 * - `maxRetriesPerRequest: 1` and a short connect timeout - the same, for a
 *   socket that is up but unresponsive;
 * - `commandTimeout` - see `RequestRedisOptions`;
 * - a capped reconnect backoff - the client keeps trying to come back, but a
 *   long outage does not become a tight loop.
 *
 * A `Queue` that only reads is fine on it: BullMQ demands
 * `maxRetriesPerRequest: null` for the blocking connections of a `Worker`
 * only.
 */
export function createRequestRedis(
  url: string,
  options: RequestRedisOptions,
): Redis {
  return withListeners(
    new Redis(url, {
      connectTimeout: REQUEST_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: options.commandTimeoutMs,
      retryStrategy: (attempt: number) =>
        Math.min(attempt * 200, REQUEST_MAX_RECONNECT_DELAY_MS),
    }),
    healthOf(options.log),
  );
}

export interface ProbeRedisOptions {
  /** How long a connect attempt gets; below the deadline of the caller. */
  connectTimeoutMs: number;
}

/**
 * The client of a short-lived process that checks Redis and exits - the
 * container healthcheck of the worker. One connect attempt and no reconnect,
 * one try per command, so that a Redis that is down is an answer rather than a
 * wait. It reports nothing: the caller reads the failure from the rejected
 * command, and the listener only keeps the same failure as an event from
 * ending the process with a stack trace instead of the verdict.
 */
export function createProbeRedis(
  url: string,
  options: ProbeRedisOptions,
): Redis {
  return withListeners(
    new Redis(url, {
      connectTimeout: options.connectTimeoutMs,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    }),
    {},
  );
}

/** The levels an outage is reported at, in the order it walks down them. */
type RedisErrorLevel = "error" | "warn" | "debug";

/**
 * Which level the n-th failure of one outage deserves. ioredis retries a dead
 * Redis every few hundred milliseconds and emits an `error` every time, so a
 * fixed `error` level buries everything else in the log within a minute -
 * including the line that says the process went down.
 *
 * The first failure keeps `error`: that is the one an operator must see. The
 * next few stay visible at `warn` (a reconnect that is taking longer than a
 * blip), and after that the same outage is only worth a counter at `debug`.
 */
function redisErrorLevel(occurrence: number): RedisErrorLevel {
  if (occurrence <= 1) {
    return "error";
  }
  return occurrence <= WARN_UNTIL_OCCURRENCE ? "warn" : "debug";
}

/** Counts one outage and writes it at a level that fades as it repeats. */
interface RedisErrorReporter {
  report(err: Error): void;
  /** Called when the client is usable again: the next outage is news again. */
  reset(): void;
}

function createRedisErrorReporter(log: RuntimeLogger): RedisErrorReporter {
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
interface RedisHealthListeners {
  onError(err: Error): void;
  onReady(): void;
}

/**
 * An outage reported at a level that fades, and a reconnect that makes the
 * next outage news again - and says so, because with the levels fading this
 * is the only line that reports recovery.
 *
 * Attached by `createQueueRedis` and `createRequestRedis` when they are given
 * a logger, so that a second entry point (the smoke CLI, the DLQ replay of
 * E13-02) cannot get half of it.
 */
function createRedisHealthListeners(log: RuntimeLogger): RedisHealthListeners {
  const reporter = createRedisErrorReporter(log);
  return {
    onError: (err: Error): void => {
      reporter.report(err);
    },
    onReady: (): void => {
      reporter.reset();
      log.info({}, "redis connection ready");
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
 * How the client went away: by a QUIT the server acknowledged, or by tearing
 * the socket down - because it was not connected, or because the QUIT was
 * refused, in which case the refusal comes along for the log.
 */
type RedisCloseOutcome =
  | { kind: "quit" }
  | { kind: "disconnected"; err?: unknown };

/**
 * Closes the client for good, whether or not it was ever connected.
 *
 * A client that is not `ready` is torn down instead of being asked to `quit`.
 * On the queue client a QUIT issued while the socket is down is not rejected -
 * it waits in the offline queue for a reconnect that may never come, and the
 * shutdown would hang until its deadline and exit with 1; on the client of
 * requests it is rejected at once, and the stop would log a failure. Either
 * way a stop during a Redis outage is a clean stop: the client is gone, which
 * is all a shutdown asked for. The `catch` covers the same answer arriving as
 * a rejection when the socket dies mid-`quit`; a refusal of any other kind is
 * nothing to fail the stop over either - there is no state left to save.
 *
 * The outcome says which path it was, for the log of the stop to say so too.
 */
export async function closeRedis(
  client: ClosableRedis,
): Promise<RedisCloseOutcome> {
  if (client.status !== "ready") {
    client.disconnect();
    return { kind: "disconnected" };
  }
  try {
    await client.quit();
    return { kind: "quit" };
  } catch (err) {
    client.disconnect();
    return { kind: "disconnected", err };
  }
}

/**
 * The client as a stage of a stop, for every process the same way. A socket
 * torn down instead of a QUIT - the client was not connected, or the QUIT was
 * refused - is still a closed client (`closeRedis`), so it is no failure of
 * the stop; but it is not a QUIT either, and the line of the stop says so,
 * with the refusal when there was one. Without this the worker wrote a
 * refused QUIT as `closed`, and the reason was lost.
 *
 * `client` is read when the stop runs: a stop that comes before the client
 * was opened has nothing to close, and says that instead of `closed`.
 */
export function redisStage(
  client: () => ClosableRedis | undefined,
): ShutdownStage {
  return stageOf(
    "redis",
    client,
    async (opened): Promise<CloseWarning | undefined> => {
      const outcome = await closeRedis(opened);
      if (outcome.kind === "quit") {
        return undefined;
      }
      return outcome.err === undefined
        ? { warning: "closed by disconnect" }
        : { warning: "closed by disconnect", err: outcome.err };
    },
  );
}
