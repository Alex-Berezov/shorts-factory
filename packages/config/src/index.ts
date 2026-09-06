import "dotenv/config";
import { z } from "zod";

/**
 * Typed, fail-fast environment configuration.
 * Every service imports `env` from here; startup crashes on invalid config.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MEDIA_DIR: z.string().default("./data/media"),
  ADMIN_PASSWORD: z.string().min(8),
  TOKEN_ENCRYPTION_KEY: z.string().length(64).optional(), // 32-byte hex

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().url().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  YT_UNITS_DAILY_SOFT_CAP: z.coerce.number().int().positive().default(8000),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),

  ELEVENLABS_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CARTESIA_API_KEY: z.string().optional(),
  TTS_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);

/** Hard operational limits (see docs/10_SYSTEM_DESIGN.md §8). */
export const limits = {
  youtubeUnitsDailySoftCap: env.YT_UNITS_DAILY_SOFT_CAP,
  geminiDailyBudgetUsd: env.GEMINI_DAILY_BUDGET_USD,
  ttsMonthlyBudgetUsd: env.TTS_MONTHLY_BUDGET_USD,
} as const;
