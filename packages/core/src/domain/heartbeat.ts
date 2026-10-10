import { WORKER_HEARTBEAT_TTL_SEC } from "./redis-keys.js";

/** What a reader of the worker's liveness stamp concludes from it. */
export interface HeartbeatReading {
  /** When the stamp was written, normalised to ISO; null when unreadable. */
  heartbeatAt: string | null;
  /** True when the worker cannot be called alive from this stamp. */
  stale: boolean;
}

/**
 * Judges the stamp under `WORKER_HEARTBEAT_KEY` against a clock. One rule for
 * every reader - `/system/status` in `apps/api` and the container healthcheck
 * of `apps/worker` - because two copies of "how old is too old" drift, and
 * then the page and the orchestrator disagree about the same worker.
 *
 * A missing stamp is stale: the TTL is what makes the key an answer rather
 * than a leftover, so an expired key means the worker stopped writing. A
 * stamp that is not a date is stale too - something else is writing under our
 * key. The age is checked as well, because a Redis that kept the key while
 * the worker's clock stood still would otherwise read as alive; a stamp
 * exactly `WORKER_HEARTBEAT_TTL_SEC` old is still fresh.
 *
 * A stamp from ahead of the reader's clock counts as fresh, as it always did
 * on the status page: the api may run on the host while the worker runs in a
 * container (or a WSL2 VM) whose clock drifts by seconds, and a cut-off there
 * would call a live worker dead. Telling a jumped clock from drift is a
 * decision of its own (docs/TECH_DEBT.md, E0-11A).
 */
export function readHeartbeat(
  stamp: string | null,
  now: Date,
): HeartbeatReading {
  if (stamp === null) {
    return { heartbeatAt: null, stale: true };
  }

  const writtenAt = Date.parse(stamp);
  if (Number.isNaN(writtenAt)) {
    return { heartbeatAt: null, stale: true };
  }

  const ageSec = (now.getTime() - writtenAt) / 1_000;
  return {
    heartbeatAt: new Date(writtenAt).toISOString(),
    stale: ageSec > WORKER_HEARTBEAT_TTL_SEC,
  };
}
