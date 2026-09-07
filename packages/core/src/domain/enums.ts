import { z } from "zod";

/**
 * Enums shared by the database and the code. Each list mirrors a pgEnum of
 * `@sf/db` value for value and in the same order; `packages/db/test/enum-parity.test.ts`
 * is the canary that fails when one side grows a value and the other does not.
 *
 * `IdeaStatus` belongs to the same family but lives in `./idea.js`, next to the
 * transition table that gives it meaning.
 */

/** Age at which a stats snapshot of a tracked video is taken (`snapshot_point`). */
export const SNAPSHOT_POINTS = [
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "48h",
  "7d",
  "adhoc",
] as const;

export const SnapshotPointSchema = z.enum(SNAPSHOT_POINTS);
export type SnapshotPoint = z.infer<typeof SnapshotPointSchema>;

/** Kind of video analysis stored in `video_analysis` (`analysis_kind`). */
export const ANALYSIS_KINDS = ["full", "hook_pass", "own_video"] as const;

export const AnalysisKindSchema = z.enum(ANALYSIS_KINDS);
export type AnalysisKind = z.infer<typeof AnalysisKindSchema>;
