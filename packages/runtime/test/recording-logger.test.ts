import { loadEnv } from "@sf/config";
import { describe, expect, it } from "vitest";
import {
  recordingLogger,
  recordingServiceLogger,
  silentLogger,
} from "../test-support/recording-logger.js";

/**
 * The capture every test of the api, the worker and this package reads its
 * lines from: a mistake here turns their assertions green or red for the
 * wrong reason.
 */
describe("recordingLogger", () => {
  it("writes the levels by name, down to trace", () => {
    const { log, levels } = recordingLogger();

    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.fatal("f");

    expect(levels()).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
  });

  it("writes the levels by name on the options of the caller too", () => {
    const { log, lines } = recordingLogger({ level: "warn" });

    log.info("dropped");
    log.warn("kept");

    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", msg: "kept" }),
    ]);
  });

  it("parses the fields of a line and keeps the raw text", () => {
    const { log, lines, raw } = recordingLogger();

    log.info({ target: "redis" }, "closed");

    expect(lines[0]).toMatchObject({
      level: "info",
      msg: "closed",
      target: "redis",
    });
    expect(raw()).toContain('"target":"redis"');
  });

  it("hands out a copy of the lines that later lines do not change", () => {
    const { log, entries } = recordingLogger();
    log.info("first");

    const before = entries();
    log.info("second");

    expect(before.map((line) => line.msg)).toEqual(["first"]);
    expect(entries().map((line) => line.msg)).toEqual(["first", "second"]);
  });

  it("forgets the lines and the raw text on clear", () => {
    const { log, lines, raw, clear } = recordingLogger();
    log.info("before");

    clear();
    log.info("after");

    expect(lines.map((line) => line.msg)).toEqual(["after"]);
    expect(raw()).not.toContain("before");
  });
});

describe("silentLogger", () => {
  it("is a logger that writes nothing at any level", () => {
    const log = silentLogger();

    expect(log.level).toBe("silent");
    expect(log.isLevelEnabled("fatal")).toBe(false);
  });
});

describe("recordingServiceLogger", () => {
  /**
   * The config of a developer's machine: the one whose options carry the
   * pretty transport, which the recorder has to leave out.
   */
  const developmentEnv = loadEnv({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://sf:sf@localhost:5442/shorts_factory_test",
    REDIS_URL: "redis://localhost:6389/1",
    ADMIN_PASSWORD: "testtest",
  });

  it("records through the redact of the service, without its transport", () => {
    const { log, lines, raw } = recordingServiceLogger(developmentEnv);

    log.info(
      { req: { headers: { authorization: "Basic c2VjcmV0LXRva2Vu" } } },
      "a request",
    );

    expect(raw()).not.toContain("c2VjcmV0LXRva2Vu");
    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "a request",
        req: { headers: { authorization: "[Redacted]" } },
      }),
    ]);
  });
});
