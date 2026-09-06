import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "../src/domain/queues.js";

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
      expect(name).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });
});
