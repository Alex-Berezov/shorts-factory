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
 * money) belongs to the worker registry of E0-08, and the operational queues
 * `system.dlq`, `system.heartbeat` and `system.smoke` are added there.
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
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
