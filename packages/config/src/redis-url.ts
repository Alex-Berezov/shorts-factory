import { type EnvLike, bootstrapEnv, isEnvValueSet } from "./env-file.js";
import { EnvSchema } from "./schema.js";

/**
 * `REDIS_URL` alone, validated by the same schema field as `env.REDIS_URL`.
 *
 * For processes that need nothing else and must not fail on anything else:
 * the worker's container healthcheck runs every 30 s, and parsing the whole
 * configuration there would report a healthy worker as unhealthy because of a
 * malformed key it never reads (a provider key, a budget). Importing this
 * module parses nothing; `@sf/config` itself parses everything on import.
 */
export function loadRedisUrl(source: EnvLike): string {
  const value = source.REDIS_URL;
  return EnvSchema.shape.REDIS_URL.parse(
    isEnvValueSet(value) ? value.trim() : undefined,
  );
}

/**
 * `loadRedisUrl` over the process environment, filled from the root `.env`
 * the way `@sf/config` fills it (`bootstrapEnv`): the file supplies only what
 * the process leaves unset - in a container of the full stack, which gets the
 * file mounted read-only, Compose sets `REDIS_URL` in `environment` and the
 * file's value is not used.
 */
export function readRedisUrl(): string {
  bootstrapEnv(process.env);
  return loadRedisUrl(process.env);
}
