import {
  BUDGET_MEASURES,
  BUDGET_PERIODS,
  BUDGET_SCOPE_KEYS,
  QUEUE_NAMES,
} from "@sf/core";
import { describe, expect, it } from "vitest";
import {
  BudgetStatusSchema,
  DependencyCheckSchema,
  QueueStatusSchema,
  SystemStatusResponseSchema,
} from "../src/system.js";

/** The answer when everything is reachable, spelled out once. */
const FULL = {
  build: { version: "0.0.1", commit: "abc1234" },
  uptimeSec: 42,
  checks: {
    db: { status: "up", reason: null },
    redis: { status: "up", reason: null },
  },
  queues: [
    {
      name: "system.smoke",
      waiting: 2,
      active: 1,
      failed: 0,
      delayed: 0,
      paused: false,
    },
  ],
  dlq: { size: 3 },
  worker: { heartbeatAt: "2026-09-13T10:00:00.000Z", stale: false },
  budget: [
    {
      key: "youtube_data_units_day",
      measure: "units",
      period: "day",
      timeZone: "America/Los_Angeles",
      spent: 1_200,
      cap: 8_000,
      ratio: 0.15,
      warn: false,
      exceeded: false,
    },
  ],
};

describe("SystemStatusResponseSchema", () => {
  it("parses the answer of a healthy instance", () => {
    expect(SystemStatusResponseSchema.parse(FULL)).toEqual(FULL);
  });

  /**
   * The shape this route exists for: an operator opens it during the incident
   * that made the sections unreadable. A section that could not be read is
   * `null` and the reason sits on the dependency - never a zero, which would
   * read as "the queue is empty".
   */
  it("parses a degraded answer with the sections that failed set to null", () => {
    const degraded = {
      ...FULL,
      checks: {
        db: { status: "up", reason: null },
        redis: { status: "down", reason: "unreachable" },
      },
      queues: null,
      dlq: null,
      worker: null,
    };

    expect(SystemStatusResponseSchema.parse(degraded)).toEqual(degraded);
  });

  it("refuses a missing section: absent is not the same as unreadable", () => {
    const { queues: _queues, ...withoutQueues } = FULL;

    expect(SystemStatusResponseSchema.safeParse(withoutQueues).success).toBe(
      false,
    );
  });

  it("refuses a field nobody declared", () => {
    // The response is serialized against this schema, so a field added on the
    // api side and not here would be dropped on the wire without a word.
    expect(
      SystemStatusResponseSchema.safeParse({ ...FULL, queuesPaused: 4 })
        .success,
    ).toBe(false);
  });

  it("refuses a count that cannot be one", () => {
    const negative = {
      ...FULL,
      queues: [{ ...FULL.queues[0], waiting: -1 }],
    };

    expect(SystemStatusResponseSchema.safeParse(negative).success).toBe(false);
  });

  it("names the caps the guard knows and the queues of the registry", () => {
    // Both enums come from `@sf/core`: a queue added to the registry or a cap
    // added to the guard must not need a second edit here to be reportable.
    expect(QueueStatusSchema.shape.name.options.slice().sort()).toEqual(
      [...QUEUE_NAMES].slice().sort(),
    );
    expect(
      SystemStatusResponseSchema.safeParse({
        ...FULL,
        budget: [{ ...FULL.budget[0], key: "twitter_usd_day" }],
      }).success,
    ).toBe(false);
    expect(BUDGET_SCOPE_KEYS).toContain(FULL.budget[0]?.key);
  });

  /**
   * The same rule for the two smaller sets. A measure or a period added to the
   * domain reaches the guard, the cache and this body; spelled out here a
   * second time it would be accepted everywhere except by the serializer of
   * the route, which answers 500 to a field it does not know.
   */
  it("takes every measure and every period the domain has", () => {
    for (const measure of BUDGET_MEASURES) {
      expect(
        BudgetStatusSchema.safeParse({ ...FULL.budget[0], measure }).success,
      ).toBe(true);
    }
    for (const period of BUDGET_PERIODS) {
      expect(
        BudgetStatusSchema.safeParse({ ...FULL.budget[0], period }).success,
      ).toBe(true);
    }
  });
});

describe("DependencyCheckSchema", () => {
  it("takes only the reasons an operator can act on", () => {
    for (const reason of ["timeout", "unreachable", "error"]) {
      expect(
        DependencyCheckSchema.safeParse({ status: "down", reason }).success,
      ).toBe(true);
    }
    // A driver message would carry hosts, ports and occasionally credentials
    // into the body of this response.
    expect(
      DependencyCheckSchema.safeParse({
        status: "down",
        reason: "getaddrinfo ENOTFOUND redis.internal",
      }).success,
    ).toBe(false);
  });

  /**
   * The invariant the page is built on: the reason belongs to a dependency
   * that is down. A pair that says both would be drawn by E0-10 as a live
   * dependency with the reason it is not - the contradiction the flat shape
   * makes expressible and this rule makes unparseable.
   */
  it("refuses a dependency that is up and has a reason anyway", () => {
    const parsed = DependencyCheckSchema.safeParse({
      status: "up",
      reason: "timeout",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["reason"]);
  });

  it("refuses a dependency that is down without saying why", () => {
    expect(
      DependencyCheckSchema.safeParse({ status: "down", reason: null }).success,
    ).toBe(false);
  });

  it("still takes the two honest pairs", () => {
    expect(
      DependencyCheckSchema.safeParse({ status: "up", reason: null }).success,
    ).toBe(true);
    expect(
      DependencyCheckSchema.safeParse({ status: "down", reason: "timeout" })
        .success,
    ).toBe(true);
  });
});
