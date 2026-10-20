import { type EnvLike, bootstrapEnv, normalizeEnvValue } from "./env-file.js";
import { rootEnvFilePath } from "./paths.js";
import { EnvSchema } from "./schema.js";

/**
 * Why `REDIS_URL` could not be had: `unset` is a value the schema takes as
 * absent - missing, empty or blank (`normalizeEnvValue`); `invalid` is one
 * that is set and is not a valid url; `env-file` is a root `.env` that exists
 * and could not be read, before any value was looked at.
 */
export type RedisUrlRefusal = "unset" | "invalid" | "env-file";

/**
 * A system code the way it may be printed: `EISDIR`, `EACCES`. Anything else
 * a thrower put in `code` is not printed - it is text out of nobody knows
 * where.
 */
const SYSTEM_CODE = /^E[A-Z0-9]{1,31}$/;

/**
 * The system code of a failed read, or `unknown`: only a Node system error
 * (one with a `syscall`) carries a code that names what the system refused.
 */
export function systemCodeOf(error: unknown): string {
  if (
    error instanceof Error &&
    "syscall" in error &&
    "code" in error &&
    typeof error.code === "string" &&
    SYSTEM_CODE.test(error.code)
  ) {
    return error.code;
  }
  return "unknown";
}

/**
 * Why `REDIS_URL` was refused, in the words the worker's healthcheck prints
 * for `docker inspect` (docs/DECISIONS.md, П1, П3, П4 E0-12G) - this is the
 * one place they are spelled. Nothing of the value: it carries the password
 * of Redis; nothing of the path or the message of a failed read either, only
 * its system code.
 */
export class RedisUrlRefusedError extends Error {
  readonly reason: RedisUrlRefusal;

  constructor(reason: "unset" | "invalid");
  constructor(reason: "env-file", code: string);
  constructor(reason: RedisUrlRefusal, code = "unknown") {
    super(
      reason === "unset"
        ? "REDIS_URL is not set"
        : reason === "invalid"
          ? "REDIS_URL is not a valid url"
          : `.env is not readable (${code})`,
    );
    this.name = "RedisUrlRefusedError";
    this.reason = reason;
  }
}

/**
 * `REDIS_URL` alone, validated by the same schema field as `env.REDIS_URL`;
 * refused with a `RedisUrlRefusedError`.
 *
 * For processes that need nothing else and must not fail on anything else:
 * the worker's container healthcheck runs every 30 s, and parsing the whole
 * configuration there would report a healthy worker as unhealthy because of a
 * malformed key it never reads (a provider key, a budget). Importing this
 * module parses nothing; `@sf/config` itself parses everything on import.
 */
export function loadRedisUrl(source: EnvLike): string {
  const value = normalizeEnvValue(source.REDIS_URL);
  const parsed = EnvSchema.shape.REDIS_URL.safeParse(value);
  if (!parsed.success) {
    throw new RedisUrlRefusedError(value === undefined ? "unset" : "invalid");
  }
  return parsed.data;
}

/**
 * `loadRedisUrl` over `target` (the process environment), filled from the
 * root `.env` the way `@sf/config` fills it (`bootstrapEnv`): the file
 * supplies only what the process leaves unset - in a container of the full
 * stack, which gets the file mounted read-only, Compose sets `REDIS_URL` in
 * `environment` and the file's value is not used.
 *
 * Refuses with nothing but a `RedisUrlRefusedError`. A failure of the fill is
 * the file's (`env-file`) by where it came from - no value has been read yet -
 * not by what its message says; a `.env` that is not there is not a failure.
 */
export function readRedisUrl(
  target: EnvLike = process.env,
  path: string = rootEnvFilePath,
): string {
  try {
    bootstrapEnv(target, path);
  } catch (error) {
    throw new RedisUrlRefusedError("env-file", systemCodeOf(error));
  }
  return loadRedisUrl(target);
}
