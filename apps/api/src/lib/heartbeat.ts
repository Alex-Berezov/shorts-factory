import type { WorkerStatus } from "@sf/contracts";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import type { WorkerProbe } from "../deps.js";

/** The part of the Redis client this reader uses. */
export interface HeartbeatReader {
  get(key: string): Promise<string | null>;
}

export interface WorkerHeartbeatOptions {
  redis: HeartbeatReader;
  /** Seam for tests; the running service reads its own clock. */
  now?: () => Date;
}

/**
 * Liveness of the worker, read from the stamp it leaves in Redis
 * (`system.heartbeat`, once a minute, with a TTL of three ticks).
 *
 * The key is the one in `@sf/core`: the writer and this reader are different
 * processes, and a literal spelled twice makes "the key was renamed"
 * indistinguishable from "nobody wrote it".
 *
 * A missing key is not an error - the TTL is what makes the stamp an answer
 * rather than a leftover, so an expired key means the worker stopped writing.
 * The age is checked as well, because a Redis that kept the key while the
 * clock of the worker stood still would otherwise read as alive.
 */
export function createWorkerProbe(
  options: WorkerHeartbeatOptions,
): WorkerProbe {
  const now = options.now ?? (() => new Date());

  return {
    async read(): Promise<WorkerStatus> {
      const stamp = await options.redis.get(WORKER_HEARTBEAT_KEY);
      if (stamp === null) {
        return { heartbeatAt: null, stale: true };
      }

      const writtenAt = Date.parse(stamp);
      if (Number.isNaN(writtenAt)) {
        // Something else is writing under our key: not a worker we can call
        // alive, and not a reason to fail the whole page.
        return { heartbeatAt: null, stale: true };
      }

      const ageSec = (now().getTime() - writtenAt) / 1_000;
      return {
        heartbeatAt: new Date(writtenAt).toISOString(),
        stale: ageSec > WORKER_HEARTBEAT_TTL_SEC,
      };
    },
  };
}
