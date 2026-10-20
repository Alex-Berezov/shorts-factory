import { WORKER_HEARTBEAT_TTL_SEC } from "./redis-keys.js";

/**
 * What a reader of the worker's liveness stamp concludes from it.
 *
 * The same shape is `WorkerStatusSchema` in `@sf/contracts`; the two are
 * locked together by a type assertion in `packages/contracts/test/system.test.ts`.
 */
export interface HeartbeatReading {
  /** The stamp exactly as the worker wrote it; null when unreadable. */
  heartbeatAt: string | null;
  /** True when the worker cannot be called alive from this stamp. */
  stale: boolean;
}

/** The only form the writer produces: `Date.prototype.toISOString()` in UTC. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * How far `stamp` is from `now`, in whole seconds: positive for a stamp
 * behind the clock (its age), negative for one ahead of it. Rounded away from
 * zero (`Math.ceil` of the magnitude), so that for the whole-second TTL
 * `Math.abs(offset) > TTL` holds exactly when the unrounded distance is past
 * the TTL: 180.4 s is 181, never 180 - a stale stamp never prints the bound.
 * One computation for every reader - `readHeartbeat` and the reason of the
 * container healthcheck - so the verdict and the number next to it cannot
 * disagree.
 *
 * For a stamp `readHeartbeat` accepted (`heartbeatAt`) and a real clock:
 * anything else is not an instant and has no distance, and is refused with a
 * `RangeError` rather than answered with `NaN`, which every comparison reads
 * as "within the TTL".
 */
export function heartbeatOffsetSec(stamp: string, now: Date): number {
  const offset = offsetSecOf(Date.parse(stamp), now);
  if (Number.isNaN(offset)) {
    throw new RangeError(
      "heartbeat offset of a stamp or a clock that is not an instant",
    );
  }
  return offset;
}

/** `heartbeatOffsetSec` of an instant already parsed. */
function offsetSecOf(writtenAtMs: number, now: Date): number {
  const offsetMs = now.getTime() - writtenAtMs;
  return Math.sign(offsetMs) * Math.ceil(Math.abs(offsetMs) / 1_000);
}

/**
 * Judges the stamp under `WORKER_HEARTBEAT_KEY` against a clock. One rule for
 * every reader - `/system/status` in `apps/api` and the container healthcheck
 * of `apps/worker` - because two copies of "how old is too old" drift, and
 * then the page and the orchestrator disagree about the same worker.
 *
 * A missing stamp is stale: the TTL is what makes the key an answer rather
 * than a leftover, so an expired key means the worker stopped writing. A
 * stamp is accepted only in the form the writer produces (`toISOString()`)
 * and only when it names a real instant - anything else is stale and is not
 * echoed: something other than the worker is writing under our key, and a
 * lenient parse would turn junk like "99999" into a worker alive until the
 * year 99999. Since only that form passes, `heartbeatAt` is the stamp itself.
 *
 * The age is checked as well, because a Redis that kept the key while the
 * worker's clock stood still would otherwise read as alive; a stamp exactly
 * `WORKER_HEARTBEAT_TTL_SEC` old is still fresh. The same bound holds ahead of
 * the reader's clock: the api may run on the host while the worker runs in a
 * container (or a WSL2 VM) whose clock drifts by seconds, so drift within the
 * TTL is alive; a stamp further ahead than that is a jumped clock, not drift,
 * and is stale while keeping its time.
 */
export function readHeartbeat(
  stamp: string | null,
  now: Date,
): HeartbeatReading {
  if (stamp === null || !ISO_STAMP.test(stamp)) {
    return { heartbeatAt: null, stale: true };
  }

  const writtenAt = Date.parse(stamp);
  if (Number.isNaN(writtenAt) || new Date(writtenAt).toISOString() !== stamp) {
    return { heartbeatAt: null, stale: true };
  }

  return {
    heartbeatAt: stamp,
    stale: Math.abs(offsetSecOf(writtenAt, now)) > WORKER_HEARTBEAT_TTL_SEC,
  };
}
