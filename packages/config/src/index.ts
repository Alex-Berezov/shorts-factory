import "dotenv/config";
import { type Env, EnvSchema } from "./schema.js";

/**
 * Typed, fail-fast environment configuration.
 * Every service imports `env` from here; startup crashes on invalid config.
 */
export type { Env } from "./schema.js";
export const env: Env = EnvSchema.parse(process.env);

/** Hard operational limits (see docs/10_SYSTEM_DESIGN.md §8). */
export const limits = {
  youtubeUnitsDailySoftCap: env.YT_UNITS_DAILY_SOFT_CAP,
  geminiDailyBudgetUsd: env.GEMINI_DAILY_BUDGET_USD,
  ttsMonthlyBudgetUsd: env.TTS_MONTHLY_BUDGET_USD,
} as const;
