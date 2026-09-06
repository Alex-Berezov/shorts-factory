import type { Env } from "./schema.js";

/** Hard operational limits (see docs/10_SYSTEM_DESIGN.md §8). */
export type Limits = {
  readonly youtubeUnitsDailySoftCap: number;
  readonly geminiDailyBudgetUsd: number;
  readonly ttsMonthlyBudgetUsd: number;
};

/**
 * Builds the limits from an already parsed env. Pure by design: the defaults
 * live in `EnvSchema`, so there is no second copy of the numbers, and the
 * caller decides which env the limits come from (`process.env` at runtime,
 * a fixture in tests).
 */
export function buildLimits(env: Env): Limits {
  return {
    youtubeUnitsDailySoftCap: env.YT_UNITS_DAILY_SOFT_CAP,
    geminiDailyBudgetUsd: env.GEMINI_DAILY_BUDGET_USD,
    ttsMonthlyBudgetUsd: env.TTS_MONTHLY_BUDGET_USD,
  };
}
