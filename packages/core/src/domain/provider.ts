import { z } from "zod";

/**
 * Every external service this project spends quota, tokens or money on, plus
 * `system` for our own bookkeeping. The values are the ones written to
 * `api_usage_log.provider` (`@sf/db`), so a typo here is not a compile error
 * somewhere else - it is a spend row nobody sums up: an aggregate filtered by
 * the correct name would report zero and the budget guard (E0-09) would let a
 * call past an exhausted cap.
 *
 * The column stays `text` for now (no pgEnum, no migration); this type is the
 * guard on the code side.
 */
export const PROVIDERS = [
  "youtube_data",
  "youtube_analytics",
  "gemini",
  "elevenlabs",
  "openai_tts",
  "google_tts",
  "cartesia",
  "system",
] as const;

export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;
