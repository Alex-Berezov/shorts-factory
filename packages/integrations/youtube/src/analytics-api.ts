/**
 * AnalyticsApiClient — own-channel metrics via OAuth2 (offline refresh token).
 * Epic E7 fills in the implementation.
 * Ingest window: re-fetch last 3–7 days daily (analytics data matures late).
 */
export interface DailyMetricsRow {
  day: string; // YYYY-MM-DD
  ytVideoId: string;
  country?: string;
  views: number;
  engagedViews?: number;
  avgViewDurationSec?: number;
  avgViewPct?: number;
  estMinutesWatched?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subsGained?: number;
  subsLost?: number;
}

export class AnalyticsApiClient {
  async fetchDaily(_from: string, _to: string): Promise<DailyMetricsRow[]> {
    throw new Error("TODO(E7): implement youtubeAnalytics.reports.query");
  }
}
