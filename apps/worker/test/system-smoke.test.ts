import { describe, expect, it, vi } from "vitest";
import { systemSmokeJob } from "../src/jobs/system-smoke.js";

describe("system.smoke payload", () => {
  it("accepts a positive safe integer as the moment of the request", () => {
    expect(
      systemSmokeJob.payloadSchema.safeParse({
        requestedAtMs: 1_773_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("refuses a moment the job id cannot carry, at the schema", () => {
    // `jobIds.systemSmoke` would refuse it too, but from `jobIdFrom`; the
    // schema is where a bad payload is supposed to stop.
    const result = systemSmokeJob.payloadSchema.safeParse({
      requestedAtMs: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(result.success).toBe(false);
  });

  it.each([0, -1, 1.5])(
    "refuses a moment that is not a positive integer: %s",
    (requestedAtMs) => {
      expect(
        systemSmokeJob.payloadSchema.safeParse({ requestedAtMs }).success,
      ).toBe(false);
    },
  );

  it("enqueues an accepted payload under system.smoke/<ms>", async () => {
    // The enqueue path of `defineJob` with a fake queue: no Redis, no network.
    // The fake answers with an id of its own: `enqueue` returns the id it put
    // into the options, not whatever the queue says back.
    const add = vi.fn(async () => ({ id: "queue-says-7" }));
    const id = await systemSmokeJob.enqueue(
      { add },
      { requestedAtMs: 1_773_000_000_000 },
    );
    expect(id).toBe("system.smoke/1773000000000");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "system.smoke",
      { requestedAtMs: 1_773_000_000_000 },
      expect.objectContaining({ jobId: "system.smoke/1773000000000" }),
    );
  });
});
