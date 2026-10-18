import { describe, expect, it } from "vitest";
import { normalizeEnvValue } from "../src/env-file.js";
import { loadEnv } from "../src/load-env.js";
import { loadRedisUrl } from "../src/redis-url.js";
import { baseSource } from "./helpers.js";

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

/**
 * The healthcheck reads `REDIS_URL` alone, the worker reads it with the rest
 * of the config: one raw value has to be one URL to both, or a check judges a
 * worker by a URL the worker never connected to.
 */
describe("loadRedisUrl next to loadEnv", () => {
  /** What `loadEnv` makes of the value, or that it refused it. */
  function viaLoadEnv(value: string | undefined): string {
    const { REDIS_URL: _unused, ...rest } = baseSource();
    const source = value === undefined ? rest : { ...rest, REDIS_URL: value };
    try {
      return loadEnv(source).REDIS_URL;
    } catch {
      return "refused";
    }
  }

  /** What `loadRedisUrl` makes of the value, or that it refused it. */
  function viaLoadRedisUrl(value: string | undefined): string {
    try {
      return loadRedisUrl(value === undefined ? {} : { REDIS_URL: value });
    } catch {
      return "refused";
    }
  }

  it.each([
    "redis://redis:6379",
    " redis://redis:6379 ",
    "\tredis://redis:6379\n",
    "",
    "   ",
    undefined,
    "not a url",
  ])("reads %j the way loadEnv reads it", (value) => {
    expect(viaLoadRedisUrl(value)).toBe(viaLoadEnv(value));
  });
});

describe("normalizeEnvValue", () => {
  it("trims a value that is set and drops one that is not", () => {
    expect(normalizeEnvValue(" redis://redis:6379 ")).toBe(
      "redis://redis:6379",
    );
    expect(normalizeEnvValue("  ")).toBeUndefined();
    expect(normalizeEnvValue("")).toBeUndefined();
    expect(normalizeEnvValue(undefined)).toBeUndefined();
  });
});
