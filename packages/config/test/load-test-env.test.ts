import { describe, expect, it } from "vitest";
import {
  type EnvLike,
  assertVitestRun,
  loadTestEnv,
} from "../vitest/load-test-env.js";

describe("assertVitestRun", () => {
  it("does not throw when VITEST=true", () => {
    expect(() => assertVitestRun({ VITEST: "true" })).not.toThrow();
  });

  it("throws when VITEST is not true", () => {
    expect(() => assertVitestRun({})).toThrow(
      "@sf/config/vitest/setup is a vitest setupFile and must not be imported at runtime",
    );
  });
});

describe("loadTestEnv", () => {
  it("purges schema keys not present in the fixture and applies fixture values", () => {
    const target: EnvLike = {
      GEMINI_API_KEY: "real",
      DATABASE_URL: "shell",
      PATH: "x",
    };
    const fixtureText = "DATABASE_URL=fixture\n";
    const keys = ["GEMINI_API_KEY", "DATABASE_URL"];

    loadTestEnv(fixtureText, target, keys);

    expect(target.GEMINI_API_KEY).toBeUndefined();
    expect(target.DATABASE_URL).toBe("fixture");
    expect(target.PATH).toBe("x");
  });
});
