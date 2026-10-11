import type { WorkerStatus } from "@sf/contracts";
import { WORKER_HEARTBEAT_KEY, readHeartbeat } from "@sf/core";
import type { WorkerProbe } from "../deps.js";
import { singleFlight } from "./single-flight.js";

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
 * What the stamp means - missing, unreadable, too old - is decided by
 * `readHeartbeat` in `@sf/core`, the same rule the container healthcheck of
 * the worker applies, so the page and the orchestrator cannot disagree.
 *
 * Requests that arrive while a read is in flight share it (`singleFlight`),
 * like every other dependency call of the api: the deadline of the page gives
 * up on a `GET` to a silent Redis without ending it, and the sharing keeps
 * that to one until the `commandTimeout` of the client (`lib/redis.ts`) ends
 * it. Nothing is kept once it settles.
 */
export function createWorkerProbe(
  options: WorkerHeartbeatOptions,
): WorkerProbe {
  const now = options.now ?? (() => new Date());

  const read = async (): Promise<WorkerStatus> => {
    const stamp = await options.redis.get(WORKER_HEARTBEAT_KEY);
    return readHeartbeat(stamp, now());
  };

  return { read: singleFlight(read) };
}
