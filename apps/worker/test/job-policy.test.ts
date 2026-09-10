import { env } from "@sf/config";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_OPTIONS,
  queueConcurrency,
} from "../src/lib/job-policy.js";

/**
 * `WORKER_CONCURRENCY` is a per-queue ceiling, so with a worker per queue the
 * process can hold that many paid calls times the number of paid queues - a
 * batch that leaves before any daily cap notices (docs/TECH_DEBT.md,
 * 06.09.2026).
 */
describe("queueConcurrency", () => {
  it("caps a queue whose every job costs money", () => {
    expect(queueConcurrency("intel.analyze-video", 5)).toBe(2);
    expect(queueConcurrency("tts.bakeoff", 10)).toBe(2);
  });

  it("leaves a free queue at the configured concurrency", () => {
    expect(queueConcurrency("radar.snapshot", 5)).toBe(5);
    expect(queueConcurrency("system.smoke", 3)).toBe(3);
  });

  it("keeps the cap a ceiling, not a floor", () => {
    // Turning the whole worker down has to turn the paid queues down too.
    expect(queueConcurrency("script.generate", 1)).toBe(1);
  });

  it("reads the same env the runtime does", () => {
    expect(queueConcurrency("system.smoke", env.WORKER_CONCURRENCY)).toBe(
      env.WORKER_CONCURRENCY,
    );
  });
});

describe("DEFAULT_JOB_OPTIONS", () => {
  it("retries with an exponential backoff and keeps a bounded history", () => {
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 1_000 },
    });
  });
});
