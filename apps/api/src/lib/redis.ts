import { Redis } from "ioredis";

/** How long a connect attempt is given before it is treated as a failure. */
const CONNECT_TIMEOUT_MS = 1_000;
/** Upper bound of the reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * Redis client for the API process. The API only pings Redis, so every option
 * here trades throughput for a fast, honest failure:
 *
 * - `enableOfflineQueue: false` - a command issued while the socket is down
 *   fails instead of waiting in a queue for a reconnect that may never come;
 *   without it `/health` hangs exactly when it is supposed to report trouble;
 * - `maxRetriesPerRequest: 1` and a short `connectTimeout` - the same reason,
 *   for a socket that is up but unresponsive;
 * - a capped reconnect backoff - the client keeps trying to come back, but a
 *   long outage does not turn into a tight reconnect loop.
 *
 * The worker (E0-08) needs the opposite of the first two options (BullMQ
 * requires `maxRetriesPerRequest: null` and blocking commands), which is why
 * this factory is not shared.
 *
 * An `error` listener is attached here, not left to the caller: ioredis emits
 * connection failures as events, and an `EventEmitter` error without a
 * listener takes the whole process down. Doing it inside the factory means
 * there is no window between the socket opening and the caller subscribing -
 * a Redis that is down must show up as `redis: "down"` in the health report,
 * never as a dead api. What to do with the error is still the caller's
 * business, through `onError`.
 */
export interface RedisOptions {
  /** Where a connection failure is reported; failures are events, not throws. */
  onError?: (err: Error) => void;
}

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  const client = new Redis(url, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt: number) =>
      Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });

  client.on("error", (err: Error) => {
    options.onError?.(err);
  });

  return client;
}

/** The part of the Redis client a shutdown uses. */
export interface ClosableRedis {
  quit(): Promise<unknown>;
  disconnect(): void;
}

/**
 * Closes the client for good, whether or not it was ever connected.
 *
 * `quit()` sends a QUIT command, and with `enableOfflineQueue: false` a
 * command issued while the socket is down is rejected instead of queued
 * (ioredis keeps the "quit on a closed client resolves anyway" branch inside
 * the offline-queue path). So the one case this exists for - Redis is down or
 * restarting while the operator stops the service - would turn a clean stop
 * into a failed one: `docker compose stop api` would log a close failure, exit
 * with 1, and a `restart: on-failure` policy would bring the container back.
 *
 * Tearing the socket down instead is what "already closed" means here, and it
 * is not an error: the client is gone either way, which is all a shutdown
 * asked for. A refusal of any other kind is still nothing to report - there is
 * no state left to save - so `disconnect()` closes both paths.
 */
export async function closeRedis(client: ClosableRedis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
