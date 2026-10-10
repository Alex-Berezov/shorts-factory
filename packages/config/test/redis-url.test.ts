import { describe, expect, it } from "vitest";
import { loadRedisUrl } from "../src/redis-url.js";

describe("loadRedisUrl", () => {
  it("returns the trimmed REDIS_URL", () => {
    expect(loadRedisUrl({ REDIS_URL: " redis://redis:6379 " })).toBe(
      "redis://redis:6379",
    );
  });

  it("ignores every other key, malformed or missing", () => {
    expect(
      loadRedisUrl({
        REDIS_URL: "redis://redis:6379",
        WORKER_CONCURRENCY: "lots",
        GEMINI_DAILY_BUDGET_USD: "-1",
      }),
    ).toBe("redis://redis:6379");
  });

  it("refuses a missing or blank REDIS_URL", () => {
    expect(() => loadRedisUrl({})).toThrow();
    expect(() => loadRedisUrl({ REDIS_URL: "  " })).toThrow();
  });

  it("refuses what the full schema refuses", () => {
    expect(() => loadRedisUrl({ REDIS_URL: "not a url" })).toThrow();
  });
});
