import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestSql, resetTestDatabase } from "./helpers.int.js";

/**
 * Indexes the schema revision of E0-04 added: every foreign key that had no
 * index of its own, plus the pair the usage aggregates scan. Literal list -
 * derived from the schema it would follow any mistake made there.
 */
const REQUIRED_INDEXES = [
  "api_usage_provider_created_idx",
  "cluster_video_video_idx",
  "experiment_recommendation_experiment_idx",
  "idea_source_cluster_idx",
  "idea_source_video_uq",
  "idea_source_video_video_idx",
  "own_video_idea_idx",
  "production_package_script_idx",
  "research_brief_idea_idx",
  "script_idea_idx",
  "trend_signal_video_idx",
  "video_analysis_video_idx",
];

const sql = openTestSql();

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("schema shape", () => {
  it("has an index on every foreign key that lacked one", async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const present = rows.map((row) => row.indexname);

    for (const name of REQUIRED_INDEXES) {
      expect(present).toContain(name);
    }
  });

  it("rejects a trend_signal status outside the enum", async () => {
    const videoId = await insertTrackedVideo("bad_status");

    await expect(sql`
      INSERT INTO trend_signal
        (video_id, views_per_hour, acceleration, baseline_ratio_x100, score_x100, status)
      VALUES (${videoId}, 1, 1, 100, 100, 'bogus')
    `).rejects.toThrow(/invalid input value for enum/);
  });

  it("accepts the documented trend_signal statuses", async () => {
    const videoId = await insertTrackedVideo("good_status");

    for (const status of ["new", "analyzed", "promoted", "ignored"]) {
      const rows = await sql<{ status: string }[]>`
        INSERT INTO trend_signal
          (video_id, views_per_hour, acceleration, baseline_ratio_x100, score_x100, status)
        VALUES (${videoId}, 1, 1, 100, 100, ${status})
        RETURNING status
      `;
      expect(rows[0]?.status).toBe(status);
    }
  });

  /**
   * `country` is null on the all-countries row, and by default Postgres counts
   * every null as distinct - the daily total would then be inserted again on
   * every analytics.ingest run instead of being updated (E7).
   */
  it("keeps one analytics_daily row per video and day when country is null", async () => {
    const ownVideoId = await insertOwnVideo("analytics_total");

    await sql`
      INSERT INTO analytics_daily (own_video_id, day, country, views)
      VALUES (${ownVideoId}, '2026-03-15', NULL, 100)
    `;

    await expect(sql`
      INSERT INTO analytics_daily (own_video_id, day, country, views)
      VALUES (${ownVideoId}, '2026-03-15', NULL, 200)
    `).rejects.toThrow(/analytics_uq/);
  });

  /**
   * The daily row is rewritten on every ingest run while the day settles, so
   * it has to say when it was written and when it was last refreshed (E7).
   */
  it("stamps analytics_daily rows with their write and refresh time", async () => {
    const ownVideoId = await insertOwnVideo("analytics_stamps");

    const rows = await sql<{ created_at: Date; updated_at: Date }[]>`
      INSERT INTO analytics_daily (own_video_id, day, country, views)
      VALUES (${ownVideoId}, '2026-03-16', 'US', 1)
      RETURNING created_at, updated_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("fixture analytics_daily was not inserted");
    }

    // Both come from the column default, so the fresh row carries the same
    // instant twice - what moves later is `updated_at` alone.
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at.getTime()).toBe(row.created_at.getTime());
  });

  it("keeps analytics_daily rows of different countries apart", async () => {
    const ownVideoId = await insertOwnVideo("analytics_countries");

    await sql`
      INSERT INTO analytics_daily (own_video_id, day, country, views)
      VALUES (${ownVideoId}, '2026-03-15', 'US', 10), (${ownVideoId}, '2026-03-15', 'DE', 20)
    `;

    const rows = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM analytics_daily WHERE own_video_id = ${ownVideoId}
    `;
    expect(rows[0]?.count).toBe("2");
  });

  /** A retried inbox.build must not attach the same source video twice (E3). */
  it("keeps one idea_source_video row per idea and video", async () => {
    const videoId = await insertTrackedVideo("idea_source");
    const ideaId = await insertIdea("idea_source");

    await sql`
      INSERT INTO idea_source_video (idea_id, video_id) VALUES (${ideaId}, ${videoId})
    `;

    await expect(sql`
      INSERT INTO idea_source_video (idea_id, video_id) VALUES (${ideaId}, ${videoId})
    `).rejects.toThrow(/idea_source_video_uq/);
  });
});

/** Fresh channel and video, so no test depends on rows another one wrote. */
async function insertTrackedVideo(suffix: string): Promise<number> {
  const channels = await sql<{ id: number }[]>`
    INSERT INTO tracked_channel (yt_channel_id, title, uploads_playlist_id)
    VALUES (${`UC_${suffix}`}, 'probe', ${`UU_${suffix}`})
    RETURNING id
  `;
  const channelId = requireId(channels[0], `tracked_channel ${suffix}`);

  const videos = await sql<{ id: number }[]>`
    INSERT INTO tracked_video (yt_video_id, channel_id, published_at, title)
    VALUES (${`vid_${suffix}`}, ${channelId}, now(), 'probe')
    RETURNING id
  `;
  return requireId(videos[0], `tracked_video ${suffix}`);
}

async function insertOwnVideo(suffix: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO own_video (yt_video_id, title)
    VALUES (${`own_${suffix}`}, 'probe')
    RETURNING id
  `;
  return requireId(rows[0], `own_video ${suffix}`);
}

async function insertIdea(suffix: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO idea (title, summary, scores, card)
    VALUES (${`idea ${suffix}`}, 'probe', '{}'::jsonb, '{}'::jsonb)
    RETURNING id
  `;
  return requireId(rows[0], `idea ${suffix}`);
}

/** No `?? 0`: a missing fixture must name itself, not fail as a foreign key. */
function requireId(row: { id: number } | undefined, what: string): number {
  if (row === undefined) {
    throw new Error(`fixture ${what} was not inserted`);
  }
  return row.id;
}
