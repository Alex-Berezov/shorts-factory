/**
 * YouTube Data API quota costs used by this project.
 * Rule (docs/10_SYSTEM_DESIGN.md §7.1): NEVER use search.list (100 units).
 * Every client method must report its cost via the usage logger.
 */
export const QUOTA_COST = {
  channelsList: 1,
  playlistItemsList: 1,
  videosList: 1, // per call, up to 50 ids batched
  videosInsert: 1600,
  captionsInsert: 400,
} as const;
