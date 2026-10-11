import { AppError } from "@sf/core";
import { type FastifyReply, type FastifyRequest, LogController } from "fastify";
import {
  type MappedError,
  SERVER_ERROR_STATUS,
  ServiceClosingError,
  printableLine,
} from "./error-mapping.js";
import { publicDetails } from "./error-response.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Whether a line about the failure of this request is already written -
     * a rejection, an error, the default handler taking over from ours, a
     * response that broke on its way out. Every later line about the same
     * request stays silent: one request, one line (docs/DECISIONS.md, Д1
     * E0-11A). Declared with the log that reads it; `buildApp` decorates the
     * request with it next to the controller below.
     */
    failureLogged: boolean;
  }
}

/** Stands in for `AppError.details` the log does not repeat verbatim. */
const OMITTED_DETAILS = "[omitted]";

/**
 * How much of an `AppError.code` a log line carries. Far more than the 64
 * characters a response allows - the log takes more than the body does, and
 * a code that never reached the caller is exactly what an incident reader
 * needs - but not the kilobyte of provider output `new AppError(String(err.code
 * ?? err.message), …)` can put into it.
 */
const MAX_LOGGED_CODE_LENGTH = 256;

/**
 * A code as text. The field is typed `string`, but the type is a promise of
 * the thrower: a plain JavaScript caller, a subclass or `Object.assign` can
 * leave `null` or a number in it, and `printableLine` on anything but a string
 * either throws - inside the error handler, which then gives the request to
 * Fastify's own - or makes an empty string of it. A primitive is written as
 * it is; anything else only by its type, since turning an object into text
 * runs code of the thrower's.
 */
function codeText(code: unknown): string {
  if (typeof code === "string") {
    return code;
  }
  if (
    code === null ||
    code === undefined ||
    typeof code === "number" ||
    typeof code === "boolean" ||
    typeof code === "bigint"
  ) {
    return String(code);
  }
  return `[${typeof code}]`;
}

/**
 * The code as it may be written down: the one line `printableLine` makes of
 * it, cut at `MAX_LOGGED_CODE_LENGTH`. Unlike the body, the log keeps a code
 * outside the identifier shape and only bounds it - the value is evidence,
 * and the line is read by an operator rather than branched on by a client.
 */
function loggableCode(code: unknown): string {
  const line = printableLine(codeText(code));
  return line.length > MAX_LOGGED_CODE_LENGTH
    ? `${line.slice(0, MAX_LOGGED_CODE_LENGTH)}...`
    : line;
}

/**
 * Whether the error already carries `code` the way the log can take it as it
 * is: an own enumerable data property holding exactly the bounded text. A
 * clean code behind a getter, or one kept out of the enumerable properties,
 * reads the same through `err.code` and is still lost by pino's serializer,
 * which writes the enumerable properties only.
 */
function hasLoggableCode(err: AppError, code: string): boolean {
  const own = Object.getOwnPropertyDescriptor(err, "code");
  return (
    own !== undefined &&
    own.enumerable === true &&
    "value" in own &&
    own.value === code
  );
}

/**
 * A plain own property, whatever the original was: pino's error serializer
 * walks the enumerable properties only, so a `code` that was a getter or a
 * non-enumerable field on the original would vanish from the line, and an
 * accessor descriptor cannot be given a `value` at all.
 */
function dataProperty(value: unknown): PropertyDescriptor {
  return { value, enumerable: true, writable: true, configurable: true };
}

/**
 * What of the error is written down.
 *
 * The log takes far more than the response does - stack, cause, the original
 * message of a 5xx - but not `AppError.details` as it was handed over: the
 * field is filled by whoever throws, and `catch (e) { throw new
 * ValidationError(msg, e) }` around an http client puts a request url with an
 * api key into it (docs/TECH_DEBT.md, 07.09.2026). `redact` covers header
 * paths only, so the substitution happens here: what a caller may see may also
 * be written down, the rest becomes a marker, so a reader of the line knows
 * the field was there. The `code` is bounded the same way the message of a
 * response is (`loggableCode`), since it is built from the same untrusted text.
 *
 * The replacement is a copy of the error, not a plain object: it keeps the
 * prototype and every own property of the original - `stack`, `cause` above
 * all - so pino's error serializer treats it like the error itself, names its
 * class in `type` and appends the chain of causes to `message` and `stack`.
 * A plain object of the six known fields lost the cause exactly when the
 * thrower had also filled `details`.
 *
 * The `stack` is copied as its text, not as its descriptor: on Node 22 it is
 * an accessor that reads a slot of the error object itself, and on a copy,
 * which has no such slot, the same getter reads `undefined` - the line would
 * name the failure without the place it was thrown from.
 */
function loggableError(err: unknown): unknown {
  if (!(err instanceof AppError)) {
    return err;
  }
  const code = loggableCode(err.code);
  if (err.details === undefined && hasLoggableCode(err, code)) {
    return err;
  }
  const replaced: PropertyDescriptorMap = {
    code: dataProperty(code),
    stack: { ...dataProperty(err.stack), enumerable: false },
  };
  if (err.details !== undefined) {
    replaced.details = dataProperty(publicDetails(err) ?? OMITTED_DETAILS);
  }
  const copy: object = Object.create(Object.getPrototypeOf(err), {
    ...Object.getOwnPropertyDescriptors(err),
    ...replaced,
  });
  return copy;
}

/**
 * What every line about one request says of it: the method, the id and the
 * declared route when the router got that far. Never the requested url -
 * before the password it is whatever the caller typed (docs/DECISIONS.md, Р1
 * and Р10 E0-11A).
 */
function requestFields(request: FastifyRequest): Record<string, unknown> {
  const routeUrl = request.routeOptions.url;
  return {
    method: request.method,
    requestId: request.id,
    ...(routeUrl === undefined ? {} : { routeUrl }),
  };
}

/** The requested path without its query string. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * The line for a request refused before the caller proved who it is - a
 * wrong password, a url the router could not parse, a broken request on the
 * socket - for a path nobody declared, and for any request to a service that
 * is closing (`logError`). `info` and without the error: an
 * anonymous client on the published port can produce these at any rate it
 * likes, and at `warn` with the whole error object every one of them is a
 * multi-line record the real failures drown in (docs/DECISIONS.md, Р1
 * E0-11A). The requested url is not written either - before the password it
 * is whatever the caller typed; `routeUrl` is the declared route, when the
 * router got that far.
 *
 * The line is the only one of its request: the access line (`logAccess`)
 * stays silent for a request that has one of these.
 */
export function logRejection(
  request: FastifyRequest,
  mapped: MappedError,
): void {
  request.failureLogged = true;
  request.log.info(
    { status: mapped.status, code: mapped.code, ...requestFields(request) },
    "request rejected",
  );
}

/**
 * One line per failed request, at the level its status and the caller call
 * for: a failure of ours is an `error` with the whole error, a 4xx of a
 * caller who gave the password is a `warn` with it, a 4xx of anyone else is
 * the short `info` line of `logRejection`.
 *
 * The 503 of a service that is closing is the short line too, whoever the
 * caller is: it is a 5xx but not a failure - every request that reaches an
 * instance on its way out gets one, and at `error` with a stack each of them
 * a deploy would read as an incident in the log and in every alert on it.
 */
export function logError(
  request: FastifyRequest,
  err: unknown,
  mapped: MappedError,
): void {
  if (
    err instanceof ServiceClosingError ||
    (mapped.status < SERVER_ERROR_STATUS && !request.authenticated)
  ) {
    logRejection(request, mapped);
    return;
  }
  request.failureLogged = true;
  const payload = {
    err: loggableError(err),
    status: mapped.status,
    code: mapped.code,
    ...requestFields(request),
  };
  if (mapped.status >= SERVER_ERROR_STATUS) {
    request.log.error(payload, "request failed");
    return;
  }
  request.log.warn(payload, "request rejected");
}

/**
 * The access line of the service: one per answered request that no failure
 * line has told about already (docs/DECISIONS.md, Р10 and Д1 E0-11A). The
 * path - without the query, which is where tokens and OAuth codes travel - only
 * for a caller who gave the password.
 */
function logAccess(request: FastifyRequest, reply: FastifyReply): void {
  if (request.failureLogged) {
    return;
  }
  request.log.info(
    {
      ...requestFields(request),
      status: reply.statusCode,
      ...(request.authenticated ? { path: pathOf(request.url) } : {}),
      responseTime: reply.elapsedTime,
    },
    "request completed",
  );
}

/**
 * Fastify's own lines about a request, without the ones that carry the
 * requested url (Р10 E0-11A): the pair `incoming request` / `request
 * completed` goes, the lines about a response that broke, a stream or a
 * serializer that failed or an error handler that threw stay - at `error`,
 * with the error as the error log writes it (`loggableError`), without the
 * `req` object whose serializer writes the url.
 *
 * The access line is written here too: Fastify calls `requestCompleted` once
 * the `onResponse` hooks are done and hands it the error the response broke
 * with, which a hook never sees - so this is the one place that can tell a
 * completed request from a failed one.
 *
 * Every failure line here but the one of the default error handler is written
 * through `failureLine` and follows the rule of the others: it is written only
 * when no line about the failure of the request is there yet, and it marks
 * the request as told about.
 */
export class AccessLogController extends LogController {
  /** The request is told about once, when it is answered. */
  override incomingRequest(): void {}

  /**
   * Without an error this is the access line (`logAccess`); with one the
   * response broke on its way out - a socket gone, a stream that failed - and
   * that is a failure of its own.
   */
  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (error === null || error === undefined) {
      logAccess(request, reply);
      return;
    }
    this.failureLine(request, reply, error, "request errored");
  }

  /**
   * Fastify's default error handler runs only when ours threw. This line does
   * not read `failureLogged` on purpose - the one named exception to the rule
   * of one line (Д1 E0-11A): it is about a second failure, of our handler
   * itself, and is written even when a line about the first one is there.
   */
  override defaultErrorLog(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    request.failureLogged = true;
    reply.log.error(
      {
        ...requestFields(request),
        status: reply.statusCode,
        err: loggableError(error),
      },
      "error handler failed",
    );
  }

  /**
   * The head of an error response could not be written - a header value Node
   * refuses - and Fastify sends the body without the headers set on the reply.
   */
  override writeHeadError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    this.failureLine(request, reply, error, "response head failed");
  }

  /** A stream sent as the body failed after the head had gone out. */
  override streamError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    this.failureLine(request, reply, error, "response stream failed");
  }

  /** The serializer declared for the status of the response threw. */
  override serializerError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    this.failureLine(request, reply, error, "response serializer failed");
  }

  /** The not-found handler of the service writes its own line. */
  override routeNotFound(): void {}

  /**
   * The one way this controller writes a failure: once per request, at
   * `error`, with what every line says of its request and the error as the
   * error log writes it.
   */
  private failureLine(
    request: FastifyRequest,
    reply: FastifyReply,
    err: Error,
    msg: string,
  ): void {
    if (request.failureLogged) {
      return;
    }
    request.failureLogged = true;
    reply.log.error(
      {
        ...requestFields(request),
        status: reply.statusCode,
        err: loggableError(err),
        responseTime: reply.elapsedTime,
      },
      msg,
    );
  }
}
