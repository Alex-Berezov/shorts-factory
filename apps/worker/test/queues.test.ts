import { describe, expect, it } from "vitest";
import { QUEUES } from "../src/queues.js";

/**
 * A duplicated queue name would break deterministic jobId derivation and DLQ
 * routing in E0-08 - this canary fails loudly if that ever happens.
 */
describe("QUEUES registry", () => {
  it("has unique queue names", () => {
    const names = Object.values(QUEUES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("follows the <module>.<action> naming template", () => {
    for (const name of Object.values(QUEUES)) {
      expect(name).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });
});
