import { describe, expect, it } from "vitest";
import { viewsPerHour } from "../src/domain/scoring.js";

describe("viewsPerHour", () => {
  it("computes delta views over delta hours", () => {
    const a = { capturedAt: new Date("2026-01-01T00:00:00Z"), views: 0 };
    const b = { capturedAt: new Date("2026-01-01T02:00:00Z"), views: 1000 };
    expect(viewsPerHour(a, b)).toBe(500);
  });
});
