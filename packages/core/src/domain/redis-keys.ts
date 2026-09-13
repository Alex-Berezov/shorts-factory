/**
 * Redis keys written by one service and read by another. A literal spelled in
 * both places drifts the moment one of them is renamed, and the reader cannot
 * tell "the key moved" from "nobody wrote it" - both look like a missing key.
 *
 * Keys that never leave a single service (BullMQ's own `bull:*` namespace, a
 * cache private to a job) do not belong here.
 */

import type { BudgetScopeKey } from "./budget.js";

/**
 * Liveness stamp of `apps/worker`: an ISO timestamp written by the
 * `system.heartbeat` job every minute with a TTL of three intervals, and read
 * by `/system/status` (E0-09) to answer "is the worker up".
 */
export const WORKER_HEARTBEAT_KEY = "worker:heartbeat";

/** How long the stamp above outlives the tick that wrote it, in seconds. */
export const WORKER_HEARTBEAT_TTL_SEC = 180;

/**
 * Cached spend of one budget scope (`BudgetScopeKey`), written by the budget
 * guard of the worker and readable by anything else that guards the same cap.
 * Namespaced away from BullMQ's own `bull:*` keys and from the heartbeat, so
 * that a `KEYS budget:*` during an incident lists the caps and nothing else.
 */
export function budgetCacheKey(scope: BudgetScopeKey): string {
  return `budget:${scope}`;
}

/**
 * How long a cached aggregate is trusted. Short enough that a cap read from
 * the cache cannot be a minute stale, long enough that a fan-out of jobs does
 * not sum the spend table per call. The window only applies below the warning
 * share: closer to a cap the guard counts from the database every time, so the
 * staleness this buys is never the staleness that lets a call past the cap.
 */
export const BUDGET_CACHE_TTL_SEC = 60;
