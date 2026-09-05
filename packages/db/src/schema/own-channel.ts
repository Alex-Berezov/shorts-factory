import {
  bigint, date, integer, jsonb, numeric, pgEnum, pgTable,
  serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { idea } from "./idea-flow.js";

export const dubKind = pgEnum("dub_kind", ["auto", "custom"]);
export const dubStatus = pgEnum("dub_status", [
  "generated", "reviewed", "published", "rejected",
]);

export const ownVideo = pgTable("own_video", {
  id: serial("id").primaryKey(),
  ytVideoId: text("yt_video_id").notNull().unique(),
  ideaId: integer("idea_id").references(() => idea.id), // null for manual Phase 0 videos
  publishedAt: timestamp("published_at", { withTimezone: true }),
  title: text("title").notNull(),
  language: text("language").notNull().default("en"),
  experimentFeatures: jsonb("experiment_features"), // blueprint §5.11 feature set
  manualLog: jsonb("manual_log"), // imported Phase-0 journal fields
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analyticsDaily = pgTable("analytics_daily", {
  id: serial("id").primaryKey(),
  ownVideoId: integer("own_video_id").notNull().references(() => ownVideo.id),
  day: date("day").notNull(),
  country: text("country"), // null = all
  views: bigint("views", { mode: "number" }).notNull().default(0),
  engagedViews: bigint("engaged_views", { mode: "number" }),
  avgViewDurationSec: numeric("avg_view_duration_sec", { precision: 8, scale: 2 }),
  avgViewPct: numeric("avg_view_pct", { precision: 5, scale: 2 }),
  estMinutesWatched: bigint("est_minutes_watched", { mode: "number" }),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  subsGained: integer("subs_gained"),
  subsLost: integer("subs_lost"),
  revenueUsd: numeric("revenue_usd", { precision: 10, scale: 4 }),
}, (t) => [uniqueIndex("analytics_uq").on(t.ownVideoId, t.day, t.country)]);

export const dubTrack = pgTable("dub_track", {
  id: serial("id").primaryKey(),
  ownVideoId: integer("own_video_id").notNull().references(() => ownVideo.id),
  language: text("language").notNull(),
  kind: dubKind("kind").notNull(),
  provider: text("provider"), // tts provider for custom tracks
  status: dubStatus("status").notNull().default("generated"),
  qualityNotes: text("quality_notes"),
  filePath: text("file_path"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("dub_uq").on(t.ownVideoId, t.language, t.kind)]);
