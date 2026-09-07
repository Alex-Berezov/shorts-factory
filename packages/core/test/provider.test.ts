import { describe, expect, it } from "vitest";
import { PROVIDERS, ProviderSchema } from "../src/domain/provider.js";

/**
 * The provider name is a filter key of `api_usage_log`, not a label: a value
 * that is not on this list writes a row no aggregate ever sums, and the budget
 * guard reads that as "nothing spent".
 */
describe("PROVIDERS", () => {
  it("lists every service E0 knows about, without duplicates", () => {
    expect([...PROVIDERS]).toEqual([
      "youtube_data",
      "youtube_analytics",
      "gemini",
      "elevenlabs",
      "openai_tts",
      "google_tts",
      "cartesia",
      "system",
    ]);
    expect(new Set(PROVIDERS).size).toBe(PROVIDERS.length);
  });

  it("rejects a hyphenated spelling of a real provider", () => {
    // The exact typo of the TECH_DEBT entry: `sumUnitsToday(db, "youtube-data")`
    // used to compile and report 0 of 10 000 units spent.
    expect(ProviderSchema.safeParse("youtube-data").success).toBe(false);
    expect(ProviderSchema.safeParse("youtube_data").success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    expect(ProviderSchema.safeParse("midjourney").success).toBe(false);
  });
});
