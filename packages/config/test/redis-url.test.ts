import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeEnvValue } from "../src/env-file.js";
import { loadEnv } from "../src/load-env.js";
import {
  RedisUrlRefusedError,
  loadRedisUrl,
  readRedisUrl,
  systemCodeOf,
} from "../src/redis-url.js";
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

  /** The refusal of `loadRedisUrl` for `source`. */
  function refusalOf(source: Record<string, string | undefined>): unknown {
    try {
      loadRedisUrl(source);
    } catch (error) {
      return error;
    }
    throw new Error("REDIS_URL was not refused");
  }

  it.each([
    ["missing", {}],
    ["empty", { REDIS_URL: "" }],
    ["blank", { REDIS_URL: " 	 " }],
  ])("says a REDIS_URL that is %s is not set", (_case, source) => {
    const refusal = refusalOf(source);

    expect(refusal).toBeInstanceOf(RedisUrlRefusedError);
    expect(refusal).toMatchObject({ reason: "unset" });
  });

  it("says a set REDIS_URL that is not a url is invalid, without its value", () => {
    const refusal = refusalOf({ REDIS_URL: "redis://user:s3cret-pass@[bad" });

    expect(refusal).toBeInstanceOf(RedisUrlRefusedError);
    // The message whole: nothing of the parser, nothing of the value.
    expect(refusal).toMatchObject({
      reason: "invalid",
      message: "REDIS_URL is not a valid url",
    });
  });

  it("says a REDIS_URL that is not set in the words of the healthcheck", () => {
    expect(refusalOf({})).toMatchObject({ message: "REDIS_URL is not set" });
  });
});

/**
 * The fill from the root `.env` before the read, outside the vitest gate of
 * `bootstrapEnv` (a target without `VITEST`) and against a path of its own,
 * never the checkout's `.env`.
 */
describe("readRedisUrl", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sf-redis-url-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The refusal of `readRedisUrl` for `target` and `path`. */
  function refusalOf(target: Record<string, string | undefined>, path: string) {
    try {
      readRedisUrl(target, path);
    } catch (error) {
      return error;
    }
    throw new Error("REDIS_URL was not refused");
  }

  it("says a .env that is a directory is not readable, with its code alone", () => {
    // What a bind mount of a missing host file leaves: a directory.
    const refusal = refusalOf({ REDIS_URL: "redis://redis:6379" }, scratch);

    expect(refusal).toBeInstanceOf(RedisUrlRefusedError);
    // The message whole: nothing of the path, nothing of the system's text.
    expect(refusal).toMatchObject({
      reason: "env-file",
      message: ".env is not readable (EISDIR)",
    });
  });

  it("reads REDIS_URL from a .env that fills it", () => {
    const file = join(scratch, "filled.env");
    writeFileSync(file, "REDIS_URL=redis://from-file:6379\n");

    expect(readRedisUrl({}, file)).toBe("redis://from-file:6379");
  });

  it("takes a .env that is not there for no file, not for a failure", () => {
    expect(refusalOf({}, join(scratch, "absent.env"))).toMatchObject({
      reason: "unset",
    });
  });
});

describe("systemCodeOf", () => {
  /** A failure the way Node's `fs` throws it. */
  function systemError(code: unknown): Error {
    return Object.assign(new Error("EACCES: permission denied, open '/x'"), {
      code,
      errno: -13,
      syscall: "open",
    });
  }

  it("takes the code of a system error", () => {
    expect(systemCodeOf(systemError("EACCES"))).toBe("EACCES");
  });

  it.each([
    ["an error that is not a system one", new Error("EISDIR")],
    [
      "an error with a code and no syscall",
      Object.assign(new Error("x"), { code: "EISDIR" }),
    ],
    ["a code outside the closed set", systemError("EACCES /etc/redis s3cret")],
    ["a code that is not a string", systemError(-13)],
    ["an error of Node that is not of the system", systemError("ERR_X")],
    ["something that is not an error", "EISDIR"],
  ])("says unknown for %s", (_case, error) => {
    expect(systemCodeOf(error)).toBe("unknown");
  });

  it("names unknown in the words of the healthcheck", () => {
    expect(new RedisUrlRefusedError("env-file", "unknown").message).toBe(
      ".env is not readable (unknown)",
    );
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
