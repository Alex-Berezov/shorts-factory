import { type Env, loadEnv } from "@sf/config";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildLoggerOptions } from "../src/lib/logger.js";

/** A parsed config, built the way the service builds it - no hand-made object. */
function envWith(overrides: Record<string, string>): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://sf:sf@localhost:5442/shorts_factory_test",
    REDIS_URL: "redis://localhost:6389/1",
    ADMIN_PASSWORD: "testtest",
    ...overrides,
  });
}

describe("buildLoggerOptions", () => {
  it("takes the level from the config", () => {
    expect(buildLoggerOptions(envWith({ LOG_LEVEL: "debug" })).level).toBe(
      "debug",
    );
  });

  it("redacts the credentials the caller sends", () => {
    // Basic auth puts the only secret of this service into `authorization`;
    // one plugin logging the headers would write it to disk in plain base64.
    expect(buildLoggerOptions(envWith({})).redact).toContain(
      "req.headers.authorization",
    );
    expect(buildLoggerOptions(envWith({})).redact).toContain(
      "req.headers.cookie",
    );
  });

  it("keeps the redis password out of the log", () => {
    // `server.ts` logs the whole ioredis error, and ioredis hangs the command
    // it failed on off that error - `auth` carries the password in `args`.
    const lines: string[] = [];
    const { transport: _unused, ...options } = buildLoggerOptions(envWith({}));
    const log = pino(options, {
      write: (line: string) => {
        lines.push(line);
      },
    });
    const err = Object.assign(new Error("connection refused"), {
      command: { name: "auth", args: ["sup3r-s3cret"] },
    });

    log.error({ err }, "redis client error");

    expect(lines).toHaveLength(1);
    expect(lines.join(" | ")).not.toContain("sup3r-s3cret");
    expect(lines.join(" | ")).toContain("connection refused");
  });

  it("pretty-prints only in development", () => {
    expect(
      buildLoggerOptions(envWith({ NODE_ENV: "development" })).transport,
    ).toMatchObject({ target: "pino-pretty" });
  });

  it("stays on json elsewhere, where pino-pretty is not installed", () => {
    // `pino-pretty` is a devDependency: a production image that asked for the
    // transport would fail to start rather than log badly.
    expect(
      buildLoggerOptions(envWith({ NODE_ENV: "test" })).transport,
    ).toBeUndefined();
    expect(
      buildLoggerOptions(
        envWith({ NODE_ENV: "production", ADMIN_PASSWORD: "0123456789abcdef" }),
      ).transport,
    ).toBeUndefined();
  });
});
