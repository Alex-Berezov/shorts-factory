import type { Env } from "@sf/config";

/**
 * Paths pino replaces with `[Redacted]`.
 *
 * ioredis attaches the command it was running to the error it emits
 * (`err.command = { name, args }`), and pino's error serializer copies every
 * own property of the error. A failed `auth` therefore carries the Redis
 * password in `args`, and `redis.ts` logs the whole error on purpose - so
 * without this the first outage on a host whose `REDIS_URL` has a password
 * writes that password into the container log and into whatever collects it.
 * The wildcard covers the same object arriving under another key (a job error
 * inside `{ queue, err }`, a nested `cause`).
 */
export const REDACTED_LOG_PATHS = [
  "err.command.args",
  "err.command",
  "*.command.args",
] as const;

/** Pretty printer options, only ever used in local development. */
interface PrettyTransport {
  target: string;
  options: Record<string, unknown>;
}

export interface WorkerLoggerOptions {
  level: Env["LOG_LEVEL"];
  redact: string[];
  transport?: PrettyTransport;
}

/**
 * Logger options for the worker process. Pure on purpose: the environment is
 * read once in `src/index.ts` and passed in, so a test can assert the shape
 * without booting pino.
 *
 * A copy of `apps/api/src/lib/logger.ts` with its own redaction list (a worker
 * has no request headers, and the api has no ioredis errors of this shape):
 * importing across apps is forbidden by §6 of the System Design, and a third
 * consumer is the point at which this moves into a package
 * (docs/TECH_DEBT.md).
 *
 * The pretty transport branches on `env.NODE_ENV`, never on
 * `process.env.NODE_ENV`: the latter stays empty on a machine that does not
 * declare it, while the config schema defaults to `production`
 * (docs/DECISIONS.md, 06.09.2026). `pino-pretty` is a devDependency and is
 * absent from the production image, so a wrong branch here would not slow the
 * worker down - it would stop it from starting.
 */
export function buildWorkerLoggerOptions(env: Env): WorkerLoggerOptions {
  const base: WorkerLoggerOptions = {
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
