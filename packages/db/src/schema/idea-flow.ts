import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { storyCluster, trackedVideo } from "./radar.js";

export const ideaStatus = pgEnum("idea_status", [
  "new",
  "approved",
  "rejected",
  "later",
  "in_research",
  "researched",
  "scripted",
  "in_production",
  "ready_to_publish",
  "published",
]);

export const researchBriefStatus = pgEnum("research_brief_status", [
  "draft",
  "operator_reviewed",
]);

export const scriptStatus = pgEnum("script_status", ["draft", "final"]);

export const idea = pgTable(
  "idea",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: ideaStatus("status").notNull().default("new"),
    scores: jsonb("scores").notNull(), // IdeaScoresSchema
    card: jsonb("card").notNull(), // full inbox card payload (why now, hooks, etc.)
    sourceClusterId: integer("source_cluster_id").references(
      () => storyCluster.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("idea_source_cluster_idx").on(t.sourceClusterId)],
);

export const ideaSourceVideo = pgTable(
  "idea_source_video",
  {
    ideaId: integer("idea_id")
      .notNull()
      .references(() => idea.id),
    videoId: integer("video_id")
      .notNull()
      .references(() => trackedVideo.id),
    role: text("role").notNull().default("reference"),
  },
  (t) => [
    // Unique on the pair, like story_cluster_video: a retried inbox.build must
    // not attach the same source twice, and the leading column also serves the
    // lookup by idea, so no separate index on `idea_id` is needed.
    uniqueIndex("idea_source_video_uq").on(t.ideaId, t.videoId),
    index("idea_source_video_video_idx").on(t.videoId),
  ],
);

export const researchBrief = pgTable(
  "research_brief",
  {
    id: serial("id").primaryKey(),
    ideaId: integer("idea_id")
      .notNull()
      .references(() => idea.id),
    verifiedClaims: jsonb("verified_claims").notNull(),
    uncertainClaims: jsonb("uncertain_claims").notNull(),
    sources: jsonb("sources").notNull(),
    riskFlags: jsonb("risk_flags").notNull(),
    allowedClaims: jsonb("allowed_claims").notNull(),
    status: researchBriefStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("research_brief_idea_idx").on(t.ideaId)],
);

export const script = pgTable(
  "script",
  {
    id: serial("id").primaryKey(),
    ideaId: integer("idea_id")
      .notNull()
      .references(() => idea.id),
    version: integer("version").notNull().default(1),
    language: text("language").notNull().default("en"),
    hooks: jsonb("hooks").notNull(), // 3–5 hook variants
    body: text("body").notNull(),
    structure: jsonb("structure").notNull(), // hook/setup/escalation/reveal/ending marks
    targetDurationSec: integer("target_duration_sec").notNull(),
    experimentTags: jsonb("experiment_tags").notNull(),
    status: scriptStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("script_idea_idx").on(t.ideaId)],
);

export const productionPackage = pgTable(
  "production_package",
  {
    id: serial("id").primaryKey(),
    scriptId: integer("script_id")
      .notNull()
      .references(() => script.id),
    shotList: jsonb("shot_list").notNull(),
    narrationTimeline: jsonb("narration_timeline").notNull(),
    overlays: jsonb("overlays").notNull(),
    notes: text("notes"),
    checklist: jsonb("checklist").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("production_package_script_idx").on(t.scriptId)],
);
