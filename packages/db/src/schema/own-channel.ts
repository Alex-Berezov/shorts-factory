import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idea } from "./idea-flow.js";

export const dubKind = pgEnum("dub_kind", ["auto", "custom"]);
export const dubStatus = pgEnum("dub_status", [
  "generated",
  "reviewed",
  "published",
  "rejected",
]);

export const ownVideo = pgTable(
  "own_video",
  {
    id: serial("id").primaryKey(),
    ytVideoId: text("yt_video_id").notNull().unique(),
    ideaId: integer("idea_id").references(() => idea.id), // null for manual Phase 0 videos
    publishedAt: timestamp("published_at", { withTimezone: true }),
    title: text("title").notNull(),
    language: text("language").notNull().default("en"),
    experimentFeatures: jsonb("experiment_features"), // blueprint §5.11 feature set
    manualLog: jsonb("manual_log"), // imported Phase-0 journal fields
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("own_video_idea_idx").on(t.ideaId)],
);

export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    id: serial("id").primaryKey(),
    ownVideoId: integer("own_video_id")
      .notNull()
      .references(() => ownVideo.id),
    day: date("day").notNull(),
    country: text("country"), // null = all
    views: bigint("views", { mode: "number" }).notNull().default(0),
    engagedViews: bigint("engaged_views", { mode: "number" }),
    avgViewDurationSec: numeric("avg_view_duration_sec", {
      precision: 8,
      scale: 2,
    }),
    avgViewPct: numeric("avg_view_pct", { precision: 5, scale: 2 }),
    estMinutesWatched: bigint("est_minutes_watched", { mode: "number" }),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    subsGained: integer("subs_gained"),
    subsLost: integer("subs_lost"),
    revenueUsd: numeric("revenue_usd", { precision: 10, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The row is updated in place: a day keeps settling for a while, and
    // `analytics.ingest` (E7) upserts it on `analytics_uq` on every run.
    // Without this column "yesterday is still being refined" looks exactly
    // like "the ingest has been down for three days".
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A unique constraint with NULLS NOT DISTINCT, not a plain unique index:
    // `country` is null for the all-countries total, and by default Postgres
    // treats every null as a different value, so the total row would not be
    // protected and `ON CONFLICT (own_video_id, day, country)` would insert a
    // duplicate on every ingest run instead of updating (E7 analytics.ingest).
    unique("analytics_uq")
      .on(t.ownVideoId, t.day, t.country)
      .nullsNotDistinct(),
  ],
);

export const dubTrack = pgTable(
  "dub_track",
  {
    id: serial("id").primaryKey(),
    ownVideoId: integer("own_video_id")
      .notNull()
      .references(() => ownVideo.id),
    language: text("language").notNull(),
    kind: dubKind("kind").notNull(),
    provider: text("provider"), // tts provider for custom tracks
    status: dubStatus("status").notNull().default("generated"),
    qualityNotes: text("quality_notes"),
    filePath: text("file_path"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dub_uq").on(t.ownVideoId, t.language, t.kind)],
);
