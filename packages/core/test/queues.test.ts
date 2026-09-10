import { describe, expect, it } from "vitest";
import {
  QUEUE_NAMES,
  QUEUE_SWITCHES_KEY,
  QueueSwitchesSchema,
  isQueueName,
} from "../src/domain/queues.js";

/**
 * A duplicated queue name would break deterministic jobId derivation and DLQ
 * routing in E0-08 - this canary fails loudly if that ever happens.
 */
describe("QUEUE_NAMES registry", () => {
  it("has unique queue names", () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });

  it("follows the <module>.<action> naming template", () => {
    for (const name of QUEUE_NAMES) {
      // Digits are legal in the action: a queue whose payload changes shape
      // is versioned rather than renamed (`analytics.ingest-v2`), and the old
      // one keeps draining next to it.
      expect(name).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
    }
  });

  it("carries the operational queues of the worker skeleton", () => {
    // Composition, not length: the seed of `queues.enabled` and the worker
    // both enumerate this list, and a name swapped for another keeps the
    // count and loses a queue.
    expect(QUEUE_NAMES).toContain("system.dlq");
    expect(QUEUE_NAMES).toContain("system.heartbeat");
    expect(QUEUE_NAMES).toContain("system.smoke");
  });

  it("answers whether a stored name is still a live queue", () => {
    expect(isQueueName("system.smoke")).toBe(true);
    // What a renamed queue leaves behind in `app_setting.queues.enabled`.
    expect(isQueueName("radar.sync")).toBe(false);
  });
});

describe("queue switches setting", () => {
  it("is stored under one key as a flat map of name to boolean", () => {
    expect(QUEUE_SWITCHES_KEY).toBe("queues.enabled");
    expect(
      QueueSwitchesSchema.parse({ "system.smoke": true, "radar.sync": false }),
    ).toEqual({ "system.smoke": true, "radar.sync": false });
  });

  it("refuses a value that is not a boolean", () => {
    // "false" as a string would read as enabled everywhere it is used.
    expect(() =>
      QueueSwitchesSchema.parse({ "system.smoke": "false" }),
    ).toThrow();
  });
});
