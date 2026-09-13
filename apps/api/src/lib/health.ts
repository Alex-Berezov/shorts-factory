import type { HealthReport, ProbeStatus } from "@sf/contracts";
import type { Db } from "@sf/db";
import { pingDb } from "@sf/db";
import type { HealthProbes } from "../deps.js";
import { withDeadline } from "./deadline.js";

/** How long one dependency is given to answer before it counts as down. */
const PROBE_TIMEOUT_MS = 2_000;

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
 * classified reason instead (`dependencyFailureCode` in `lib/system-status.ts`;
 * `lib/deadline.ts` holds only the timer both share).
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
 */
export function createHealthProbes(options: HealthProbesOptions): HealthProbes {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return {
    async check(): Promise<HealthReport> {
      const [db, redis] = await Promise.all([
        probe(() => pingDb(options.db), timeoutMs),
        probe(() => options.redis.ping(), timeoutMs),
      ]);
      return { db, redis };
    },
  };
}
