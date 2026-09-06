import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { repoRoot } from "./paths.js";

/** Highest port number a TCP socket can bind to. */
const MAX_PORT = 65535;

/**
 * Upper bound per queue, not per process: `apps/worker` runs one `Worker` per
 * queue, so the process holds up to this many jobs times the number of handler
 * queues. A resource guard against a typo (`50` for `5`) on a single machine -
 * spending is guarded elsewhere (the daily caps and the budget guard), not by
 * this number.
 */
const MAX_WORKER_CONCURRENCY = 10;

/** 32 bytes of AES-256-GCM key material, hex encoded. */
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

/**
 * Media files live in one place for every package. A relative value is
 * resolved against the repository root, so `pnpm test` from a package
 * directory does not scatter `data/` folders across the workspace; an
 * absolute value (containers set `/data/media`) is kept as is.
 */
function toAbsoluteMediaDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

/**
 * Env schema definition only - no parsing, no side effects. Kept separate
 * from `index.ts` so the vitest test fixture loader can enumerate its keys
 * without triggering the `.env` loader or `loadEnv()`.
 *
 * Stays a plain `ZodObject`: `.shape` is the single source of the key list
 * for the fixture in `vitest/setup.ts`. Cross-field rules go to the derived
 * schema in `load-env.ts`, which would otherwise erase `.shape`.
 */
export const EnvSchema = z.object({
  // Fail-safe default: a machine that does not declare its environment is
  // treated as production, so the production rules (see `load-env.ts`) cannot
  // be dodged by leaving `NODE_ENV` out of the file and out of the shell.
  // Local work opts into `development` explicitly - see `.env.example`.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MEDIA_DIR: z.string().default("./data/media").transform(toAbsoluteMediaDir),
  ADMIN_PASSWORD: z.string().min(8),
  // Charset matters: 64 non-hex characters would pass a length check and then
  // `Buffer.from(key, "hex")` would silently yield a truncated AES key.
  TOKEN_ENCRYPTION_KEY: z.string().regex(HEX_32_BYTES).optional(),

  API_PORT: z.coerce.number().int().positive().max(MAX_PORT).default(3001),
  WEB_PORT: z.coerce.number().int().positive().max(MAX_PORT).default(3000),
  API_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_WORKER_CONCURRENCY)
    .default(5),

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
