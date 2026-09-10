import { z } from "zod";

/**
 * Queue registry - the single source of truth for queue names, listed in
 * docs/10_SYSTEM_DESIGN.md §4 (triggers and semantics live there).
 *
 * It sits in `@sf/core` next to the jobId builders (decision 5 of E0) because
 * two packages need it and neither may depend on the other: `apps/worker`
 * builds a `Queue` per name, and `@sf/db` seeds one switch per name into
 * `app_setting.queues.enabled`. A second copy would drift silently - a queue
 * missing from the seed reads back as `undefined` instead of a switch.
 *
 * Names only. Runtime metadata (concurrency caps, cron, whether a queue costs
 * money) belongs to the worker registry of E0-08; the operational queues
 * `system.dlq`, `system.heartbeat` and `system.smoke` are part of the registry
 * itself, because they too get a switch in `app_setting` and a `Queue`.
 */
export const QUEUE_NAMES = [
  "radar.sync-channels",
  "radar.snapshot",
  "radar.score",
  "radar.cluster",
  "radar.baseline",
  "intel.analyze-video",
  "intel.hook-pass",
  "inbox.build",
  "inbox.later-return",
  "research.run",
  "script.generate",
  "production.package",
  "analytics.ingest",
  "analytics.materialize",
  "experiment.recompute",
  "experiment.features",
  "localize.script",
  "tts.generate",
  "tts.bakeoff",
  "publish.upload",
  "publish.sync-status",
  "publish.localizations",
  "publish.captions",
  "system.usage-rollup",
  "system.quota-guard",
  "system.quota-reset",
  // Operational queues of the worker skeleton (E0-08). `system.dlq` has no
  // processor on purpose: final failures are copied into it and stay there
  // until an operator looks at them (E13-02).
  "system.dlq",
  "system.heartbeat",
  "system.smoke",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const QUEUE_NAME_SET: ReadonlySet<string> = new Set(QUEUE_NAMES);

/** Whether a name read from storage or from a request is still a live queue. */
export function isQueueName(name: string): name is QueueName {
  return QUEUE_NAME_SET.has(name);
}

/**
 * Row of `app_setting` that carries one switch per queue. Spelled once: the
 * seed writes it (`@sf/db`), the worker reads it every minute and the api of
 * E13-02 writes it back when an operator pauses a queue.
 */
export const QUEUE_SWITCHES_KEY = "queues.enabled";

/**
 * The switches as they are stored: a flat map of queue name to "may run".
 *
 * A record of `string`, not of `QueueName`: the row outlives the registry. A
 * queue that was renamed leaves its key behind until the next seed removes it,
 * and a reader that refuses to parse the whole row because of one stale key
 * would take the worker down over a setting that no longer means anything.
 * Deciding what to do with a key outside `QUEUE_NAMES` is the reader's job -
 * see `apps/worker/src/lib/queue-switches.ts`.
 */
export const QueueSwitchesSchema = z.record(z.string(), z.boolean());

/** Queue switches as stored in `app_setting.queues.enabled`. */
export type QueueSwitches = z.infer<typeof QueueSwitchesSchema>;
