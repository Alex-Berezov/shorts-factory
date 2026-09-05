import {
  bigint, boolean, index, integer, jsonb, pgEnum, pgTable,
  serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

export const snapshotPoint = pgEnum("snapshot_point", [
  "1h", "3h", "6h", "12h", "24h", "48h", "7d", "adhoc",
]);

export const trackedChannel = pgTable("tracked_channel", {
  id: serial("id").primaryKey(),
  ytChannelId: text("yt_channel_id").notNull().unique(),
  title: text("title").notNull(),
  uploadsPlaylistId: text("uploads_playlist_id").notNull(),
  baselineStats: jsonb("baseline_stats"), // median/percentile views by video age
  isActive: boolean("is_active").notNull().default(true),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trackedVideo = pgTable("tracked_video", {
  id: serial("id").primaryKey(),
  ytVideoId: text("yt_video_id").notNull().unique(),
  channelId: integer("channel_id").notNull().references(() => trackedChannel.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  durationSec: integer("duration_sec"),
  title: text("title").notNull(),
  description: text("description"),
  isShort: boolean("is_short").notNull().default(true),
}, (t) => [index("tracked_video_channel_idx").on(t.channelId)]);

export const videoStatsSnapshot = pgTable("video_stats_snapshot", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull().references(() => trackedVideo.id),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  point: snapshotPoint("point").notNull(),
  views: bigint("views", { mode: "number" }).notNull(),
  likes: integer("likes"),
  comments: integer("comments"),
}, (t) => [
  index("snapshot_video_time_idx").on(t.videoId, t.capturedAt),
  uniqueIndex("snapshot_video_point_uq").on(t.videoId, t.point),
]);

export const trendSignal = pgTable("trend_signal", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull().references(() => trackedVideo.id),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  viewsPerHour: integer("views_per_hour").notNull(),
  acceleration: integer("acceleration").notNull(),
  baselineRatio: integer("baseline_ratio_x100").notNull(), // ratio * 100
  score: integer("score_x100").notNull(), // score * 100
  status: text("status").notNull().default("new"), // new | analyzed | promoted | ignored
}, (t) => [index("trend_signal_score_idx").on(t.score)]);

export const storyCluster = pgTable("story_cluster", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  momentum: jsonb("momentum"),
});

export const storyClusterVideo = pgTable("story_cluster_video", {
  clusterId: integer("cluster_id").notNull().references(() => storyCluster.id),
  videoId: integer("video_id").notNull().references(() => trackedVideo.id),
}, (t) => [uniqueIndex("cluster_video_uq").on(t.clusterId, t.videoId)]);
