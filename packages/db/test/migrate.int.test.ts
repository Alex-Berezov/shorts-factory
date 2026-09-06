import { env } from "@sf/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { openTestSql, resetTestDatabase } from "./helpers.int.js";

/**
 * DoD of E0-04: the migration runner brings an empty database to the model of
 * System Design §5. The table list is a literal - a list read from the schema
 * would pass even if the migration created nothing.
 */
const TABLES_SECTION_5 = [
  "analytics_daily",
  "api_usage_log",
  "app_setting",
  "dub_track",
  "experiment",
  "experiment_recommendation",
  "idea",
  "idea_source_video",
  "oauth_token",
  "own_video",
  "production_package",
  "prompt_version",
  "research_brief",
  "script",
  "story_cluster",
  "story_cluster_video",
  "tracked_channel",
  "tracked_video",
  "trend_signal",
  "video_analysis",
  "video_stats_snapshot",
];

const sql = openTestSql();

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("runMigrations", () => {
  it("creates every table of System Design §5 on an empty database", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual(TABLES_SECTION_5);
  });

  it("is idempotent: a second run applies nothing and does not fail", async () => {
    await expect(runMigrations(env.DATABASE_URL)).resolves.toBeUndefined();

    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    expect(rows).toHaveLength(TABLES_SECTION_5.length);
  });
});
