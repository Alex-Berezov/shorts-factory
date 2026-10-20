import type { HealthReport, ProbeStatus } from "@sf/contracts";
import { type ProbeDb, pingDb } from "@sf/db";
import { withDeadline } from "@sf/runtime";
import type { HealthProbes } from "../deps.js";
import { DEPENDENCY_TIMEOUT_MS } from "./dependency-timeout.js";
import { singleFlight } from "./single-flight.js";

/** The part of the Redis client a probe uses. */
export interface Pingable {
  ping(): Promise<string>;
}

export interface HealthProbesOptions {
  /** The bounded handle of the db probe (`createProbeDb`), its own. */
  db: ProbeDb;
  redis: Pingable;
  /** Overridden by tests; the default is what the running service uses. */
  timeoutMs?: number;
}

/**
 * Runs one probe under the shared deadline and answers up or down.
 *
 * The reason a probe failed is not returned: it is a message from an external
 * system and `/health` is public. `/system/status`, which is not, reports a
 * classified reason instead (`dependencyFailureCode` in `lib/system-status.ts`);
 * the bound is shared with it through `lib/dependency-timeout.ts`.
 */
async function probe(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<ProbeStatus> {
  try {
    await withDeadline(run, timeoutMs, { unref: false });
    return "up";
  } catch {
    return "down";
  }
}

/**
 * Liveness of the dependencies, both probed at once: they are independent, and
 * a sequential run would make the endpoint as slow as the sum of two
 * timeouts.
 *
 * Concurrent calls share the call to each dependency (`singleFlight`), each
 * under its own deadline. `/health` is public and polled by a healthcheck, a
 * proxy and anyone with curl, and the deadline does not cancel a probe. The
 * sharing is over the raw call, not over the verdict, and lasts until the
 * call settles: a probe that hangs past the deadline is the one every later
 * poll joins - one hanging call per dependency, not one per poll.
 *
 * How long one can hang is bounded for both. A ping to a Redis whose socket
 * is open and silent ends by the `commandTimeout` of its client
 * (`createRequestRedis`, `compose-app.ts`). A database probe ends by the
 * limit of its handle, `PROBE_QUERY_LIMIT_MS` (`createProbeDb` of `@sf/db`):
 * the server ends a slow query by `statement_timeout`, and a query on a
 * half-open socket, which nothing on the server can end, is given up on with
 * its connection, so the next poll after the limit asks over a new one
 * instead of joining a probe that would otherwise wait for the
 * retransmissions of the OS (docs/TECH_DEBT.md § E0-12H, п.5). The handle is
 * this probe's own: on one connection a stuck read of the `budget` section
 * would queue the ping behind it. Nothing is kept once a call has answered.
 */
export function createHealthProbes(options: HealthProbesOptions): HealthProbes {
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const pingDatabase = singleFlight(() => options.db.run(pingDb));
  const pingRedis = singleFlight(() => options.redis.ping());

  return {
    async check(): Promise<HealthReport> {
      const [db, redis] = await Promise.all([
        probe(pingDatabase, timeoutMs),
        probe(pingRedis, timeoutMs),
      ]);
      return { db, redis };
    },
  };
}
