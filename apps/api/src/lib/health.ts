import type { HealthReport, ProbeStatus } from "@sf/contracts";
import type { Db } from "@sf/db";
import { pingDb } from "@sf/db";
import type { HealthProbes } from "../deps.js";
import { DEPENDENCY_TIMEOUT_MS, withDeadline } from "./deadline.js";
import { singleFlight } from "./single-flight.js";

/** The part of the Redis client a probe uses. */
export interface Pingable {
  ping(): Promise<string>;
}

export interface HealthProbesOptions {
  db: Db;
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
 * the deadline and its bound are shared with it through `lib/deadline.ts`.
 */
async function probe(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<ProbeStatus> {
  try {
    await withDeadline(run, timeoutMs);
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
 * How long one can hang differs by dependency. A ping to a Redis whose socket
 * is open and silent ends by the `commandTimeout` of its client
 * (`lib/redis.ts`). A database probe has no bound of its own: the
 * `connect_timeout` of `createDb` stops counting once the connection is
 * ready, postgres-js puts no timeout on a query, and its cancel cannot be
 * used yet (docs/TECH_DEBT.md, rows of E0-11B, to E0-12B). Such a probe ends
 * when the server answers or the OS breaks the socket: on a half-open socket
 * that is retransmission for up to ~15 minutes, since keepalive only acts on
 * an idle connection. All that time `/health` answers 503 (`db: down`, each
 * poll on its own deadline) and the `budget` section is empty while Postgres
 * is alive. Nothing is kept once a call has answered.
 */
export function createHealthProbes(options: HealthProbesOptions): HealthProbes {
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const pingDatabase = singleFlight(() => pingDb(options.db));
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
