import type { Env } from "@sf/config";

/**
 * Paths pino replaces with `[Redacted]`. Basic auth ships the admin password
 * base64-encoded in `authorization`, so any handler or plugin that dumps
 * `req.headers` (a 400 from the body parser already logs the request) would
 * write the single secret of this service into the log file.
 *
 * The last three cover the other secret this service holds: ioredis attaches
 * the command it was running to the error it emits (`err.command = { name,
 * args }`), pino's error serializer copies every own property of an error, and
 * `server.ts` logs the whole Redis error - so a failed `auth` against a Redis
 * with a password would print that password.
 */
export const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "err.command.args",
  "err.command",
  "*.command.args",
] as const;

/** Pretty printer options, only ever used in local development. */
interface PrettyTransport {
  target: string;
  options: Record<string, unknown>;
}

export interface ApiLoggerOptions {
  level: Env["LOG_LEVEL"];
  redact: string[];
  transport?: PrettyTransport;
}

/**
 * Logger options for `buildApp`. Pure on purpose: the environment is read once
 * in `server.ts` and passed in, so tests can assert the shape without booting
 * pino.
 *
 * The pretty transport branches on `env.NODE_ENV`, never on
 * `process.env.NODE_ENV`: the latter stays empty on a machine that does not
 * declare it, while the config schema defaults to `production`
 * (docs/DECISIONS.md, 06.09.2026). `pino-pretty` is a devDependency and is
 * absent from the production image, so a wrong branch here would not slow the
 * service down - it would stop it from starting.
 */
export function buildLoggerOptions(env: Env): ApiLoggerOptions {
  const base: ApiLoggerOptions = {
    level: env.LOG_LEVEL,
    redact: [...REDACTED_LOG_PATHS],
  };

  if (env.NODE_ENV !== "development") {
    return base;
  }

  return {
    ...base,
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    },
  };
}
