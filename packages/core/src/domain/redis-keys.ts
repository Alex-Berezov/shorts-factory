/**
 * Redis keys written by one service and read by another. A literal spelled in
 * both places drifts the moment one of them is renamed, and the reader cannot
 * tell "the key moved" from "nobody wrote it" - both look like a missing key.
 *
 * Keys that never leave a single service (BullMQ's own `bull:*` namespace, a
 * cache private to a job) do not belong here.
 */

/**
 * Liveness stamp of `apps/worker`: an ISO timestamp written by the
 * `system.heartbeat` job every minute with a TTL of three intervals, and read
 * by `/system/status` (E0-09) to answer "is the worker up".
 */
export const WORKER_HEARTBEAT_KEY = "worker:heartbeat";

/** How long the stamp above outlives the tick that wrote it, in seconds. */
export const WORKER_HEARTBEAT_TTL_SEC = 180;
