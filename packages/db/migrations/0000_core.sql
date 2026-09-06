CREATE TYPE "public"."snapshot_point" AS ENUM('1h', '3h', '6h', '12h', '24h', '48h', '7d', 'adhoc');--> statement-breakpoint
CREATE TYPE "public"."trend_signal_status" AS ENUM('new', 'analyzed', 'promoted', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."analysis_kind" AS ENUM('full', 'hook_pass', 'own_video');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('new', 'approved', 'rejected', 'later', 'in_research', 'researched', 'scripted', 'in_production', 'ready_to_publish', 'published');--> statement-breakpoint
CREATE TYPE "public"."research_brief_status" AS ENUM('draft', 'operator_reviewed');--> statement-breakpoint
CREATE TYPE "public"."script_status" AS ENUM('draft', 'final');--> statement-breakpoint
CREATE TYPE "public"."dub_kind" AS ENUM('auto', 'custom');--> statement-breakpoint
CREATE TYPE "public"."dub_status" AS ENUM('generated', 'reviewed', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('planned', 'running', 'done');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "story_cluster" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"momentum" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "story_cluster_video" (
	"cluster_id" integer NOT NULL,
	"video_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracked_channel" (
	"id" serial PRIMARY KEY NOT NULL,
	"yt_channel_id" text NOT NULL,
	"title" text NOT NULL,
	"uploads_playlist_id" text NOT NULL,
	"baseline_stats" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_channel_yt_channel_id_unique" UNIQUE("yt_channel_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracked_video" (
	"id" serial PRIMARY KEY NOT NULL,
	"yt_video_id" text NOT NULL,
	"channel_id" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"duration_sec" integer,
	"title" text NOT NULL,
	"description" text,
	"is_short" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tracked_video_yt_video_id_unique" UNIQUE("yt_video_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trend_signal" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views_per_hour" integer NOT NULL,
	"acceleration" integer NOT NULL,
	"baseline_ratio_x100" integer NOT NULL,
	"score_x100" integer NOT NULL,
	"status" "trend_signal_status" DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_stats_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"point" "snapshot_point" NOT NULL,
	"views" bigint NOT NULL,
	"likes" integer,
	"comments" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_analysis" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer,
	"local_file_path" text,
	"kind" "analysis_kind" NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"dna" jsonb NOT NULL,
	"cost_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" "idea_status" DEFAULT 'new' NOT NULL,
	"scores" jsonb NOT NULL,
	"card" jsonb NOT NULL,
	"source_cluster_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea_source_video" (
	"idea_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"role" text DEFAULT 'reference' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_package" (
	"id" serial PRIMARY KEY NOT NULL,
	"script_id" integer NOT NULL,
	"shot_list" jsonb NOT NULL,
	"narration_timeline" jsonb NOT NULL,
	"overlays" jsonb NOT NULL,
	"notes" text,
	"checklist" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_brief" (
	"id" serial PRIMARY KEY NOT NULL,
	"idea_id" integer NOT NULL,
	"verified_claims" jsonb NOT NULL,
	"uncertain_claims" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"risk_flags" jsonb NOT NULL,
	"allowed_claims" jsonb NOT NULL,
	"status" "research_brief_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "script" (
	"id" serial PRIMARY KEY NOT NULL,
	"idea_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"hooks" jsonb NOT NULL,
	"body" text NOT NULL,
	"structure" jsonb NOT NULL,
	"target_duration_sec" integer NOT NULL,
	"experiment_tags" jsonb NOT NULL,
	"status" "script_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analytics_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"own_video_id" integer NOT NULL,
	"day" date NOT NULL,
	"country" text,
	"views" bigint DEFAULT 0 NOT NULL,
	"engaged_views" bigint,
	"avg_view_duration_sec" numeric(8, 2),
	"avg_view_pct" numeric(5, 2),
	"est_minutes_watched" bigint,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"subs_gained" integer,
	"subs_lost" integer,
	"revenue_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_uq" UNIQUE NULLS NOT DISTINCT("own_video_id","day","country")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dub_track" (
	"id" serial PRIMARY KEY NOT NULL,
	"own_video_id" integer NOT NULL,
	"language" text NOT NULL,
	"kind" "dub_kind" NOT NULL,
	"provider" text,
	"status" "dub_status" DEFAULT 'generated' NOT NULL,
	"quality_notes" text,
	"file_path" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "own_video" (
	"id" serial PRIMARY KEY NOT NULL,
	"yt_video_id" text NOT NULL,
	"idea_id" integer,
	"published_at" timestamp with time zone,
	"title" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"experiment_features" jsonb,
	"manual_log" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "own_video_yt_video_id_unique" UNIQUE("yt_video_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiment" (
	"id" serial PRIMARY KEY NOT NULL,
	"hypothesis" text NOT NULL,
	"design" jsonb NOT NULL,
	"status" "experiment_status" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"conclusion" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiment_recommendation" (
	"id" serial PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" text NOT NULL,
	"confidence" numeric(4, 3),
	"based_on" jsonb NOT NULL,
	"experiment_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_usage_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"units" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 5),
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_token" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_token_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "story_cluster_video" ADD CONSTRAINT "story_cluster_video_cluster_id_story_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."story_cluster"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "story_cluster_video" ADD CONSTRAINT "story_cluster_video_video_id_tracked_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracked_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracked_video" ADD CONSTRAINT "tracked_video_channel_id_tracked_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."tracked_channel"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trend_signal" ADD CONSTRAINT "trend_signal_video_id_tracked_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracked_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "video_stats_snapshot" ADD CONSTRAINT "video_stats_snapshot_video_id_tracked_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracked_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "video_analysis" ADD CONSTRAINT "video_analysis_video_id_tracked_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracked_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idea" ADD CONSTRAINT "idea_source_cluster_id_story_cluster_id_fk" FOREIGN KEY ("source_cluster_id") REFERENCES "public"."story_cluster"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idea_source_video" ADD CONSTRAINT "idea_source_video_idea_id_idea_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."idea"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idea_source_video" ADD CONSTRAINT "idea_source_video_video_id_tracked_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracked_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_package" ADD CONSTRAINT "production_package_script_id_script_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."script"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_brief" ADD CONSTRAINT "research_brief_idea_id_idea_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."idea"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script" ADD CONSTRAINT "script_idea_id_idea_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."idea"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_own_video_id_own_video_id_fk" FOREIGN KEY ("own_video_id") REFERENCES "public"."own_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dub_track" ADD CONSTRAINT "dub_track_own_video_id_own_video_id_fk" FOREIGN KEY ("own_video_id") REFERENCES "public"."own_video"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "own_video" ADD CONSTRAINT "own_video_idea_id_idea_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."idea"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiment_recommendation" ADD CONSTRAINT "experiment_recommendation_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiment"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_video_uq" ON "story_cluster_video" USING btree ("cluster_id","video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_video_video_idx" ON "story_cluster_video" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracked_video_channel_idx" ON "tracked_video" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trend_signal_score_idx" ON "trend_signal" USING btree ("score_x100");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trend_signal_video_idx" ON "trend_signal" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapshot_video_time_idx" ON "video_stats_snapshot" USING btree ("video_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "snapshot_video_point_uq" ON "video_stats_snapshot" USING btree ("video_id","point");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_analysis_video_idx" ON "video_analysis" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_source_cluster_idx" ON "idea" USING btree ("source_cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idea_source_video_uq" ON "idea_source_video" USING btree ("idea_id","video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_source_video_video_idx" ON "idea_source_video" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_package_script_idx" ON "production_package" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_brief_idea_idx" ON "research_brief" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_idea_idx" ON "script" USING btree ("idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dub_uq" ON "dub_track" USING btree ("own_video_id","language","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "own_video_idea_idx" ON "own_video" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_recommendation_experiment_idx" ON "experiment_recommendation" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_usage_provider_created_idx" ON "api_usage_log" USING btree ("provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_uq" ON "prompt_version" USING btree ("name","version");