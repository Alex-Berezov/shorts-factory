import { z } from "zod";
import { type EnvLike, isEnvValueSet } from "./env-file.js";
import { type Env, EnvSchema } from "./schema.js";

/** Minimum admin password length once the app runs in production. */
const PRODUCTION_ADMIN_PASSWORD_MIN = 16;

/**
 * Trims every value, then drops the keys left empty - one notion of a value
 * for the whole config: a value is what `trim()` returns, and "set" means
 * non-empty after `trim()` (the rule `isEnvValueSet` states for the file
 * loader too). A key with no value in `.env.example`
 * (`TOKEN_ENCRYPTION_KEY=`) parses to an empty string, and an empty string is
 * "not set", not "set to nothing" - without this every optional field of the
 * example config would fail its format check.
 *
 * Trimming happens here and nowhere else: `process.env` keeps whatever the
 * shell or the file put there, and every reader of the config goes through
 * `loadEnv`. Without it the two halves disagree at character level - a
 * password with a trailing space is "set" by `trim()` but stored with the
 * space, and fifteen spaces plus one character pass the production length
 * rule.
 */
function normalizeValues(source: EnvLike): EnvLike {
  const result: EnvLike = {};
  for (const [key, value] of Object.entries(source)) {
    if (isEnvValueSet(value)) {
      result[key] = value.trim();
    }
  }
  return result;
}

/**
 * `EnvSchema` plus cross-field rules. Lives here and not in `schema.ts`
 * because a refinement returns a `ZodEffects` without `.shape`, and `.shape`
 * is what the vitest fixture uses to purge `process.env`.
 */
const LoadedEnvSchema = EnvSchema.superRefine((env, ctx) => {
  if (
    env.NODE_ENV === "production" &&
    env.ADMIN_PASSWORD.length < PRODUCTION_ADMIN_PASSWORD_MIN
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ADMIN_PASSWORD"],
      message: `ADMIN_PASSWORD must be at least ${PRODUCTION_ADMIN_PASSWORD_MIN} characters when NODE_ENV=production`,
    });
  }
});

/**
 * Parses env values into the typed config. Pure: reads no files and mutates
 * neither `source` nor `process.env`, which is what makes it usable from
 * tests with a handcrafted source object.
 */
export function loadEnv(source: EnvLike = process.env): Env {
  return LoadedEnvSchema.parse(normalizeValues(source));
}
