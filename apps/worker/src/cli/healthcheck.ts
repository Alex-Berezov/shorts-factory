/**
 * Container healthcheck of the worker (`infra/docker-compose.app.yml`):
 * exit 0 when the heartbeat stamp in Redis is fresh, 1 otherwise. Answers the
 * question `/system` answers - "is the worker writing its stamp" - with the
 * same rule (`readHeartbeat` in `@sf/core`), so the orchestrator and the page
 * cannot disagree about the same worker. A process that is up but whose jobs
 * do not run is what this is for; a process that is down is the runtime's to
 * notice. The decision itself is `runHealthcheck` (`healthcheck-run.ts`); this
 * file is the process around it.
 *
 * Runs as a separate short-lived process next to the worker, so it uses the
 * probe client of `@sf/runtime` (`createProbeRedis`): no reconnect
 * and one try per command - a Redis that is down must be an answer within the
 * deadline, not a wait. It and the deadline are taken by their subpaths
 * (`@sf/runtime/redis`, `@sf/runtime/deadline`), not by the root of the
 * package: the root loads bullmq and pino, which this process never uses,
 * and every run would pay for loading them out of the same five seconds. One line on stdout says why; Docker keeps it in
 * `docker inspect` next to the exit code.
 *
 * It reads `REDIS_URL` and nothing else (`@sf/config/redis-url`): parsing the
 * whole configuration every 30 s would turn a malformed key the worker does
 * not even use into "unhealthy".
 */
import { readRedisUrl } from "@sf/config/redis-url";
import { createProbeRedis } from "@sf/runtime/redis";
import {
  HEALTHCHECK_BACKSTOP_MS,
  HEALTHCHECK_BACKSTOP_REASON,
  HEALTHCHECK_DEADLINE_MS,
  runHealthcheck,
} from "./healthcheck-run.js";

/**
 * Below the deadline of the read (`HEALTHCHECK_DEADLINE_MS`), so a refused or
 * silent connect is reported as such rather than as a read with no answer.
 */
const HEALTHCHECK_CONNECT_TIMEOUT_MS = 3_000;

function finish(healthy: boolean, reason: string): never {
  process.stdout.write(`${healthy ? "healthy" : "unhealthy"}: ${reason}\n`);
  process.exit(healthy ? 0 : 1);
}

// Only for the case where the read's own deadline fails to answer (a fault in
// `runHealthcheck` or `settleWithin`). Module loading is over before this line
// and the teardown below is synchronous, so neither is covered here.
setTimeout(() => {
  finish(false, HEALTHCHECK_BACKSTOP_REASON);
}, HEALTHCHECK_BACKSTOP_MS);

let redisUrl: string;
try {
  redisUrl = readRedisUrl();
} catch (error) {
  finish(
    false,
    `REDIS_URL is not usable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Without a logger the factory still attaches an `error` listener: the
// failure arrives as the rejection of `get`, and the same failure as an
// unheard `error` event would end the process with a stack trace instead of
// the verdict.
const client = createProbeRedis(redisUrl, {
  connectTimeoutMs: HEALTHCHECK_CONNECT_TIMEOUT_MS,
});

const verdict = await runHealthcheck({
  redis: client,
  now: () => new Date(),
  deadlineMs: HEALTHCHECK_DEADLINE_MS,
});
client.disconnect();
finish(verdict.healthy, verdict.reason);
