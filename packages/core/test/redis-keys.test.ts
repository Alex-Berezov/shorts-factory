import { describe, expect, it } from "vitest";
import { BUDGET_SCOPE_KEYS } from "../src/domain/budget.js";
import {
  BUDGET_CACHE_TTL_SEC,
  WORKER_HEARTBEAT_KEY,
  budgetCacheKey,
} from "../src/domain/redis-keys.js";

/**
 * Both keys below are written by one process and read by another, so their
 * spelling is the contract. A drift does not fail anywhere: the reader simply
 * finds nothing, and "no cached spend" looks exactly like "nothing spent".
 */
describe("budgetCacheKey", () => {
  it("keeps the spelling every service agrees on", () => {
    expect(budgetCacheKey("youtube_data_units_day")).toBe(
      "budget:youtube_data_units_day",
    );
    expect(budgetCacheKey("gemini_usd_day")).toBe("budget:gemini_usd_day");
    expect(budgetCacheKey("tts_usd_month")).toBe("budget:tts_usd_month");
  });

  it("gives every scope a key of its own, outside the other namespaces", () => {
    const keys = BUDGET_SCOPE_KEYS.map(budgetCacheKey);

    expect(new Set(keys).size).toBe(BUDGET_SCOPE_KEYS.length);
    expect(keys).not.toContain(WORKER_HEARTBEAT_KEY);
    for (const key of keys) {
      expect(key.startsWith("bull:")).toBe(false);
    }
  });
});

describe("BUDGET_CACHE_TTL_SEC", () => {
  it("is the minute the epic asks for", () => {
    expect(BUDGET_CACHE_TTL_SEC).toBe(60);
  });
});
