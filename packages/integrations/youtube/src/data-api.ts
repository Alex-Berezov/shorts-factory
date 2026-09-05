/**
 * DataApiClient — public reads (tracked channels, video metadata, stats)
 * via API key. Epic E1 fills in the implementation.
 *
 * Design constraints:
 * - new-video sync via uploads playlist only (1 unit), never search.list;
 * - stats snapshots via videos.list with batched ids (<=50 per call);
 * - every call reports units to the UsageLogger and respects the daily soft cap.
 */
import type { UsageLogger } from "./quota.js";

export interface ChannelInfo {
  ytChannelId: string;
  title: string;
  uploadsPlaylistId: string;
}

export interface VideoStats {
  ytVideoId: string;
  views: number;
  likes: number | null;
  comments: number | null;
}

export class DataApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly logUsage: UsageLogger,
  ) {}

  async resolveChannel(_handleOrId: string): Promise<ChannelInfo> {
    throw new Error("TODO(E1): implement channels.list resolution");
  }

  async listNewUploads(_uploadsPlaylistId: string, _sincePublishedAt?: Date) {
    throw new Error("TODO(E1): implement playlistItems.list sync");
  }

  async batchVideoStats(_ytVideoIds: string[]): Promise<VideoStats[]> {
    throw new Error("TODO(E1): implement videos.list batched snapshots");
  }
}
