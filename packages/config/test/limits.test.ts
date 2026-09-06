import { afterEach, describe, expect, it } from "vitest";
import { buildLimits } from "../src/limits.js";
import { loadEnv } from "../src/load-env.js";
import { baseSource } from "./helpers.js";

const softCapKey = "YT_UNITS_DAILY_SOFT_CAP";

describe("buildLimits", () => {
  const shellValue = process.env[softCapKey];

  afterEach(() => {
    if (shellValue === undefined) {
      delete process.env[softCapKey];
    } else {
      process.env[softCapKey] = shellValue;
    }
  });

  it("takes the numbers from the given env, not from process.env", () => {
    process.env[softCapKey] = "1";

    const limits = buildLimits(
      loadEnv(
        baseSource({
          YT_UNITS_DAILY_SOFT_CAP: "4200",
          GEMINI_DAILY_BUDGET_USD: "7.5",
          TTS_MONTHLY_BUDGET_USD: "120",
        }),
      ),
    );

    expect(limits).toEqual({
      youtubeUnitsDailySoftCap: 4200,
      geminiDailyBudgetUsd: 7.5,
      ttsMonthlyBudgetUsd: 120,
    });
  });

  it("uses the schema defaults when the env does not set them", () => {
    const limits = buildLimits(loadEnv(baseSource()));

    expect(limits).toEqual({
      youtubeUnitsDailySoftCap: 8000,
      geminiDailyBudgetUsd: 5,
      ttsMonthlyBudgetUsd: 50,
    });
  });
});
