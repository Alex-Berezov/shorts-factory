import type { HealthReport, ProbeStatus } from "@sf/contracts";
import type { Db } from "@sf/db";
import { pingDb } from "@sf/db";
import type { HealthProbes } from "../deps.js";

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
 * Runs one probe under a deadline.
 *
 * The deadline is the point of this function: a TCP connection to a machine
 * that stopped answering neither resolves nor rejects, so a probe without it
 * would hold `/health` open until the client gives up - the one moment the
 * endpoint has to answer. The reason a probe failed is not returned: it is a
 * message from an external system, and `/health` is public.
 */
async function probe(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<ProbeStatus> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([run(), deadline]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
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
