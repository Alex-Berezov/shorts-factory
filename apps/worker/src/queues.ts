/**
 * Queue registry — single source of truth for queue names.
 * See docs/10_SYSTEM_DESIGN.md §4 for triggers and semantics.
 */
export const QUEUES = {
  radarSyncChannels: "radar.sync-channels",
  radarSnapshot: "radar.snapshot",
  radarScore: "radar.score",
  radarCluster: "radar.cluster",
  intelAnalyzeVideo: "intel.analyze-video",
  intelHookPass: "intel.hook-pass",
  inboxBuild: "inbox.build",
  researchRun: "research.run",
  scriptGenerate: "script.generate",
  productionPackage: "production.package",
  analyticsIngest: "analytics.ingest",
  experimentRecompute: "experiment.recompute",
  localizeScript: "localize.script",
  ttsGenerate: "tts.generate",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
