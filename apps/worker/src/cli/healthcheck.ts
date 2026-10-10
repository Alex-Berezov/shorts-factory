/**
 * Container healthcheck of the worker (`infra/docker-compose.app.yml`):
 * exit 0 when the heartbeat stamp in Redis is fresh, 1 otherwise. Answers the
 * question `/system` answers - "is the worker writing its stamp" - with the
 * same rule (`readHeartbeat` in `@sf/core`), so the orchestrator and the page
 * cannot disagree about the same worker. A process that is up but whose jobs
 * do not run is what this is for; a process that is down is the runtime's to
 * notice.
 *
 * Runs as a separate short-lived process next to the worker, so it uses a
 * client of its own and the opposite options of `lib/redis.ts`: no reconnect
 * and one try per command - a Redis that is down must be an answer within the
 * deadline, not a wait. One line on stdout says why; Docker keeps it in
 * `docker inspect` next to the exit code.
 *
 * It reads `REDIS_URL` and nothing else (`@sf/config/redis-url`): parsing the
 * whole configuration every 30 s would turn a malformed key the worker does
 * not even use into "unhealthy".
 */
import { readRedisUrl } from "@sf/config/redis-url";
import { WORKER_HEARTBEAT_KEY, readHeartbeat } from "@sf/core";
import { Redis } from "ioredis";

/** Everything - connect, read, verdict - fits in this, or the check fails. */
const DEADLINE_MS = 5_000;
/** Below the deadline, so a refused or silent Redis is reported as such. */
const CONNECT_TIMEOUT_MS = 3_000;

function finish(healthy: boolean, reason: string): never {
  process.stdout.write(`${healthy ? "healthy" : "unhealthy"}: ${reason}\n`);
  process.exit(healthy ? 0 : 1);
}

setTimeout(() => {
  finish(false, `no answer from redis within ${DEADLINE_MS} ms`);
}, DEADLINE_MS);

let redisUrl: string;
try {
  redisUrl = readRedisUrl();
} catch (error) {
  finish(
    false,
    `REDIS_URL is not usable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const client = new Redis(redisUrl, {
  connectTimeout: CONNECT_TIMEOUT_MS,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
// The failure arrives as the rejection of the command below; without a
// listener the same failure as an `error` event would end the process with a
// stack trace instead of the verdict.
client.on("error", () => undefined);

let healthy: boolean;
let reason: string;
try {
  const stamp = await client.get(WORKER_HEARTBEAT_KEY);
  const reading = readHeartbeat(stamp, new Date());
  healthy = !reading.stale;
  reason =
    stamp === null
      ? "no heartbeat stamp in redis"
      : reading.heartbeatAt === null
        ? "heartbeat stamp is not a date"
        : `last heartbeat at ${reading.heartbeatAt}`;
} catch (error) {
  healthy = false;
  reason = `redis unreachable: ${error instanceof Error ? error.message : String(error)}`;
}
client.disconnect();
finish(healthy, reason);
