import { describe, expect, it } from "vitest";
import { VITEST_MARKER } from "../src/env-file.js";
import { assertVitestRun } from "../vitest/assert-vitest-run.js";

describe("assertVitestRun", () => {
  it("does not throw inside a vitest worker", () => {
    expect(() => assertVitestRun({ VITEST: VITEST_MARKER })).not.toThrow();
  });

  it("throws when the vitest marker is absent", () => {
    expect(() => assertVitestRun({})).toThrow(
      "@sf/config/vitest/setup is a vitest setupFile and must not be imported at runtime",
    );
  });

  it("reads the marker vitest actually sets", () => {
    // The gate and `bootstrapEnv` share one constant; if it stopped matching
    // the runner, the fixture would keep passing while the runtime quietly
    // started reading the developer's `.env` under tests.
    expect(process.env.VITEST).toBe(VITEST_MARKER);
  });
});
