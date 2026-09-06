import {
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { trackedVideo } from "./radar.js";

export const analysisKind = pgEnum("analysis_kind", [
  "full",
  "hook_pass",
  "own_video",
]);

/**
 * Every Gemini analysis result. dna JSONB is validated against
 * ContentDnaSchema (@sf/core) on write and read. Never overwritten —
 * re-analysis inserts a new row.
 */
export const videoAnalysis = pgTable("video_analysis", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").references(() => trackedVideo.id), // null for local own files
  localFilePath: text("local_file_path"),
  kind: analysisKind("kind").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  dna: jsonb("dna").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
