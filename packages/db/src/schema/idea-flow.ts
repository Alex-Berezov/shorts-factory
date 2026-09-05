import {
  integer, jsonb, pgEnum, pgTable, serial, text, timestamp,
} from "drizzle-orm/pg-core";
import { storyCluster, trackedVideo } from "./radar.js";

export const ideaStatus = pgEnum("idea_status", [
  "new", "approved", "rejected", "later", "in_research", "researched",
  "scripted", "in_production", "ready_to_publish", "published",
]);

export const idea = pgTable("idea", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: ideaStatus("status").notNull().default("new"),
  scores: jsonb("scores").notNull(), // IdeaScoresSchema
  card: jsonb("card").notNull(), // full inbox card payload (why now, hooks, etc.)
  sourceClusterId: integer("source_cluster_id").references(() => storyCluster.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const ideaSourceVideo = pgTable("idea_source_video", {
  ideaId: integer("idea_id").notNull().references(() => idea.id),
  videoId: integer("video_id").notNull().references(() => trackedVideo.id),
  role: text("role").notNull().default("reference"),
});

export const researchBrief = pgTable("research_brief", {
  id: serial("id").primaryKey(),
  ideaId: integer("idea_id").notNull().references(() => idea.id),
  verifiedClaims: jsonb("verified_claims").notNull(),
  uncertainClaims: jsonb("uncertain_claims").notNull(),
  sources: jsonb("sources").notNull(),
  riskFlags: jsonb("risk_flags").notNull(),
  allowedClaims: jsonb("allowed_claims").notNull(),
  status: text("status").notNull().default("draft"), // draft | operator_reviewed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const script = pgTable("script", {
  id: serial("id").primaryKey(),
  ideaId: integer("idea_id").notNull().references(() => idea.id),
  version: integer("version").notNull().default(1),
  language: text("language").notNull().default("en"),
  hooks: jsonb("hooks").notNull(), // 3–5 hook variants
  body: text("body").notNull(),
  structure: jsonb("structure").notNull(), // hook/setup/escalation/reveal/ending marks
  targetDurationSec: integer("target_duration_sec").notNull(),
  experimentTags: jsonb("experiment_tags").notNull(),
  status: text("status").notNull().default("draft"), // draft | final
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productionPackage = pgTable("production_package", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id").notNull().references(() => script.id),
  shotList: jsonb("shot_list").notNull(),
  narrationTimeline: jsonb("narration_timeline").notNull(),
  overlays: jsonb("overlays").notNull(),
  notes: text("notes"),
  checklist: jsonb("checklist").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
