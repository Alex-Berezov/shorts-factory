import { type Env, loadEnv } from "@sf/config";
import { type Logger, pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildWorkerLoggerOptions } from "../src/lib/logger.js";

/** An error the way ioredis emits it: the command it failed on comes along. */
function ioredisError(secret: string): Error & {
  command: { name: string; args: string[] };
} {
  const err = new Error("READONLY You can't write against a read only replica");
  return Object.assign(err, { command: { name: "auth", args: [secret] } });
}

/** The lines a logger built from these options actually writes. */
function linesOf(env: Env): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const { transport: _unused, ...options } = buildWorkerLoggerOptions(env);
  const log = pino(options, {
    write: (line: string) => {
      lines.push(line);
    },
  });
  return { log, lines };
}

/** A parsed config, built the way the worker builds it - no hand-made object. */
function envWith(overrides: Record<string, string>): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://sf:sf@localhost:5442/shorts_factory_test",
    REDIS_URL: "redis://localhost:6389/1",
    ADMIN_PASSWORD: "testtest",
    ...overrides,
  });
}

describe("buildWorkerLoggerOptions", () => {
  it("takes the level from the config", () => {
    expect(
      buildWorkerLoggerOptions(envWith({ LOG_LEVEL: "debug" })).level,
    ).toBe("debug");
  });

  it("keeps the redis password out of the log", () => {
    // ioredis hangs the command on the error it emits and pino's serializer
    // copies every own property of an error: a failed `auth` against a Redis
    // whose URL carries a password would otherwise print that password, and
    // `redis.ts` logs the whole error on purpose.
    const { log, lines } = linesOf(envWith({}));

    log.error({ err: ioredisError("sup3r-s3cret") }, "redis client error");
    log.error(
      { queue: "system.smoke", err: ioredisError("sup3r-s3cret") },
      "worker error",
    );

    expect(lines).toHaveLength(2);
    expect(lines.join(" | ")).not.toContain("sup3r-s3cret");
    expect(lines.join(" | ")).toContain("READONLY");
  });

  it("pretty-prints only in development", () => {
    expect(
      buildWorkerLoggerOptions(envWith({ NODE_ENV: "development" })).transport,
    ).toMatchObject({ target: "pino-pretty" });
  });

  it("stays on json elsewhere, where pino-pretty is not installed", () => {
    // `pino-pretty` is a devDependency: a production image that asked for the
    // transport would fail to start rather than log badly.
    expect(
      buildWorkerLoggerOptions(envWith({ NODE_ENV: "test" })).transport,
    ).toBeUndefined();
    expect(
      buildWorkerLoggerOptions(
        envWith({ NODE_ENV: "production", ADMIN_PASSWORD: "0123456789abcdef" }),
      ).transport,
    ).toBeUndefined();
  });
});
