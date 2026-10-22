import type { Env } from "@sf/config";
import { field, isObject, redactCommandArgs } from "./redact-command-args.js";

/**
 * Paths pino replaces with `[Redacted]`, one list for every process.
 *
 * Basic auth ships the admin password base64-encoded in `authorization`, so
 * any handler or plugin that dumps `req.headers` (a 400 from the body parser
 * already logs the request) would write the single secret of the api into the
 * log file; the cookies go with it.
 *
 * The Redis password rides in the `args` of a command at any depth of a line.
 * The walk of `formatters.log` (`redactCommandArgs`) covers the object of a
 * line, and the serializer of `err` drops `args` altogether; the paths of a
 * command stay here as well, because the bindings of `log.child()` reach
 * neither - pino writes them through `redact` and the serializers only - and
 * one level is what a binding of a command is put at.
 */
const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "command.args",
  "err.command.args",
  "*.command.args",
] as const;

/**
 * Keys of a line that have a rule of their own in every logger: `err` its
 * serializer below. `req` and `res` are not among them: their serializers are
 * Fastify's, on the loggers of the api requests only, and a worker or a
 * command line tool that logs `{ res: { reply } }` has nothing else between a
 * command under it and the file. The walk costs little on what Fastify hands
 * its serializers - a request and a reply are instances of classes, which it
 * does not enter (`redactCommandArgs`).
 */
const OWN_RULE_KEYS: ReadonlySet<string> = new Set(["err"]);

/** How many links of `cause` (or levels of `errors`) are written at most. */
const MAX_ERROR_DEPTH = 8;

/**
 * Where an error carries the details it may have written down, under a key
 * of its own: what a caller of the api was shown, or a marker that the field
 * was there (`loggableError`, apps/api). The serializer writes this, never
 * `details` itself: the details of an `AppError` are whatever its thrower put
 * there - a request url with a key, the answer of a provider - and the worker
 * and the command line tools hand their errors to the logger as they are.
 * A symbol, so that no thrower fills it by accident and no body of the api
 * carries it.
 */
export const LOGGED_DETAILS: unique symbol = Symbol("logged details");

/**
 * Fields of an error that are written as they are, when they are a string, a
 * number or a boolean. What an operator reads off a failure - the code of a
 * driver or of the domain, the system call and the address a socket failed
 * on, the status an `AppError` maps to and the one Fastify puts on its own
 * errors (`statusCode`: a 415 and a 500 are different stories) - and nothing
 * a client library hangs off an error for its own use.
 */
const SCALAR_ERROR_FIELDS = [
  "code",
  "errno",
  "syscall",
  "address",
  "port",
  "httpStatus",
  "statusCode",
] as const;

/** A serialized error: the whitelisted fields and nothing else. */
type LoggedError = Record<string, unknown>;

/** What the walk below one outermost error carries from link to link. */
interface CauseWalk {
  /** Errors already written: a cycle of causes ends at the first repeat. */
  seen: Set<object>;
  /**
   * The links whose stack is already in the stack of the outermost error
   * (`withCauses`); every other error below it gets its own.
   */
  stacked: ReadonlySet<object>;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** A text field of an object, or nothing when it is not a string. */
function text(source: object, key: string): string | undefined {
  const value = field(source, key);
  return typeof value === "string" ? value : undefined;
}

/** The name of the class an object was built by, as pino writes it. */
function typeOf(source: object): string | undefined {
  const ctor = field(source, "constructor");
  if (typeof ctor === "function" && ctor.name !== "") {
    return ctor.name;
  }
  return text(source, "name");
}

/**
 * The links of `cause` below `source` that are errors - an object with a
 * message, the way pino tells them - within `MAX_ERROR_DEPTH` and without
 * coming back to one already listed.
 */
function causesOf(source: object): object[] {
  const chain: object[] = [];
  const seen = new Set<object>([source]);
  let current = field(source, "cause");
  while (
    isObject(current) &&
    text(current, "message") !== undefined &&
    !seen.has(current) &&
    chain.length < MAX_ERROR_DEPTH
  ) {
    chain.push(current);
    seen.add(current);
    current = field(current, "cause");
  }
  return chain;
}

/**
 * The message and the stack of the outermost error the way pino writes them
 * (`messageWithCauses`, `stackWithCauses` of pino-std-serializers): those of
 * every cause appended, so that one field reads as the whole story. Bounded
 * by the same depth as the fields below; `chain` is `causesOf(source)`,
 * walked once by the caller.
 */
function withCauses(
  source: object,
  chain: readonly object[],
): { message?: string; stack?: string } {
  const message = text(source, "message");
  const stack = text(source, "stack");
  return {
    ...(message === undefined
      ? {}
      : {
          message: [
            message,
            ...chain.map((cause) => text(cause, "message") ?? ""),
          ].join(": "),
        }),
    ...(stack === undefined
      ? {}
      : {
          stack: [
            stack,
            ...chain.map((cause) => text(cause, "stack") ?? ""),
          ].join("\ncaused by: "),
        }),
  };
}

/**
 * A `cause` or a member of `errors` as it is written: an error through the
 * same rule, a string, a number or a boolean as it is - `new Error(msg, {
 * cause: "ECONNRESET" })` is a reason too - and nothing for the rest.
 */
function nestedValue(
  value: unknown,
  depth: number,
  walk: CauseWalk,
): { value: unknown } | undefined {
  if (isScalar(value)) {
    return { value };
  }
  if (!isObject(value)) {
    return undefined;
  }
  const nested = nestedError(value, depth, walk);
  return nested === undefined ? undefined : { value: nested };
}

/**
 * The whitelisted fields of one error, then its `cause` and its `errors`
 * through the same rule. `base` is what is written for `type`, `message` and
 * `stack`: with the chain of causes appended for the outermost error, the
 * error's own for everything below it.
 */
function pickFields(
  source: object,
  base: { type?: unknown; message?: unknown; stack?: unknown },
  depth: number,
  walk: CauseWalk,
): LoggedError {
  const out: LoggedError = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  for (const key of SCALAR_ERROR_FIELDS) {
    const value = field(source, key);
    if (isScalar(value)) {
      out[key] = value;
    }
  }
  const details = field(source, LOGGED_DETAILS);
  if (details !== undefined) {
    out.details = details;
  }
  const command = field(source, "command");
  if (isObject(command)) {
    const name = field(command, "name");
    if (typeof name === "string") {
      out.command = { name };
    }
  }
  const cause = nestedValue(field(source, "cause"), depth + 1, walk);
  if (cause !== undefined) {
    out.cause = cause.value;
  }
  const errors = field(source, "errors");
  if (Array.isArray(errors)) {
    out.errors = errors.flatMap((item: unknown) => {
      const nested = nestedValue(item, depth + 1, walk);
      return nested === undefined ? [] : [nested.value];
    });
  }
  return out;
}

/**
 * An error below the outermost one, or nothing once the chain is too deep or
 * comes back to an error already written - a cycle of causes must not hang
 * the process that is trying to report a failure.
 *
 * The stack of a link of the outermost chain is left out: it is already
 * appended to the stack of the outermost error. Every other error has its
 * own written - a member of an `AggregateError` and the causes below it, a
 * link past an object without a message, where that chain stops - or the
 * place it was thrown at would be lost.
 */
function nestedError(
  source: object,
  depth: number,
  walk: CauseWalk,
): LoggedError | undefined {
  if (depth > MAX_ERROR_DEPTH || walk.seen.has(source)) {
    return undefined;
  }
  walk.seen.add(source);
  return pickFields(
    source,
    {
      type: typeOf(source),
      message: field(source, "message"),
      ...(walk.stacked.has(source) ? {} : { stack: field(source, "stack") }),
    },
    depth,
    walk,
  );
}

/**
 * The `err` serializer of every logger: a **whitelist** of fields, applied to
 * the error, to each link of its `cause` and to the members of an
 * `AggregateError`.
 *
 * pino's own serializer copies every enumerable property of an error, and the
 * errors of client libraries carry their request with them: a refused call of
 * an http client brings `config.url` with the key in it and `response.data`
 * whole, a query of postgres-js brings `query` and `parameters`, a command of
 * ioredis brings `command.args` with the password of an `auth`. A list of
 * paths to redact has to name each of those, at each depth a `cause` can put
 * them at; a list of fields to keep does not.
 *
 * Anything that is not an object - a string thrown, `null` - is written as
 * it is, the way pino writes it.
 */
function serializeError(err: unknown): unknown {
  if (!isObject(err)) {
    return err;
  }
  const chain = causesOf(err);
  return pickFields(err, { type: typeOf(err), ...withCauses(err, chain) }, 0, {
    seen: new Set<object>([err]),
    stacked: new Set<object>(chain),
  });
}

/**
 * The `log` formatter of every logger: the object of a line, with the `args`
 * of every command of ioredis in it redacted (`redactCommandArgs`). pino runs
 * it before the serializers and before `redact`, so the key with a serializer
 * of every logger is left to it.
 */
function formatLogObject(
  object: Record<string, unknown>,
): Record<string, unknown> {
  return redactCommandArgs(object, OWN_RULE_KEYS);
}

/** Pretty printer options, only ever used in local development. */
interface PrettyTransport {
  target: string;
  options: Record<string, unknown>;
}

interface LoggerOptions {
  level: Env["LOG_LEVEL"];
  redact: string[];
  serializers: { err: (err: unknown) => unknown };
  formatters: {
    log: (object: Record<string, unknown>) => Record<string, unknown>;
  };
  transport?: PrettyTransport;
}

/**
 * Logger options for every process. Pure on purpose: the environment is read
 * once at the entry point and passed in, so tests can assert the shape
 * without booting pino, and the `pino()` call stays in the app - which is
 * where pino resolves the `pino-pretty` transport from.
 *
 * The pretty transport branches on `env.NODE_ENV`, never on
 * `process.env.NODE_ENV`: the latter stays empty on a machine that does not
 * declare it, while the config schema defaults to `production`
 * (docs/DECISIONS.md, 06.09.2026). `pino-pretty` is a devDependency and is
 * absent from the production image, so a wrong branch here would not slow the
 * service down - it would stop it from starting.
 */
export function buildLoggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: [...REDACTED_LOG_PATHS],
    serializers: { err: serializeError },
    formatters: { log: formatLogObject },
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
