import { describe, expect, it } from "vitest";
import {
  HEALTH_ANSWER_STATUSES,
  HEALTH_STATUS_CODES,
  HealthResponseSchema,
} from "../src/health.js";

describe("health statuses", () => {
  it("answers ok with 200 and degraded with 503", () => {
    // A container healthcheck and `depends_on` in Compose branch on the code
    // alone, and both the route and the client read it from here.
    expect(HEALTH_STATUS_CODES).toEqual({ ok: 200, degraded: 503 });
  });

  it("gives a status to every state the answer can carry", () => {
    expect(Object.keys(HEALTH_STATUS_CODES).sort()).toEqual(
      [...HealthResponseSchema.shape.status.options].sort(),
    );
  });

  it("reads as answers exactly the statuses of the states", () => {
    expect([...HEALTH_ANSWER_STATUSES].sort()).toEqual(
      Object.values(HEALTH_STATUS_CODES).sort(),
    );
  });
});
