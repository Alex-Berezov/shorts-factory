import { AppError, errorCode } from "@sf/core";
import { LOGGED_DETAILS } from "@sf/runtime";
import { type FastifyReply, type FastifyRequest, LogController } from "fastify";
import { ServiceClosingError } from "./error-mapping.js";
import { publicDetails } from "./error-response.js";
import { printableLine } from "./error-text.js";
import { type MappedError, SERVER_ERROR_STATUS } from "./mapped-error.js";

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
 * leave a number or an object in it, and `printableLine` on anything but a
 * string either throws - inside the error handler, which then gives the
 * request to Fastify's own - or makes an empty string of it. A primitive is
 * written as it is; anything else only by its type, since turning an object
 * into text runs code of the thrower's.
 */
function codeText(code: unknown): string {
  if (typeof code === "string") {
    return code;
  }
  if (
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
 *
 * An absent code (`null`, `undefined`) is not one: `undefined`, and the line
 * carries no `code` of the error at all, rather than the words `"null"` or
 * `"undefined"` a reader would take for a code somebody chose. Nor is one
 * that makes no line - empty, blank, control characters only: `code: ""`
 * says nothing and reads as a choice too.
 */
function loggableCode(code: unknown): string | undefined {
  if (code === null || code === undefined) {
    return undefined;
  }
  const line = printableLine(codeText(code));
  if (line === "") {
    return undefined;
  }
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
function hasLoggableCode(err: AppError, code: string | undefined): boolean {
  if (code === undefined) {
    return false;
  }
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
 *
 * The replaced details go to the logger under `LOGGED_DETAILS` of
 * `@sf/runtime` as well: its serializer writes that key and never `details`,
 * which on any error that did not pass through here is the thrower's own.
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
    stack: { ...dataProperty(err.stack), enumerable: false },
  };
  if (code !== undefined) {
    replaced.code = dataProperty(code);
  }
  if (err.details !== undefined) {
    const logged = publicDetails(err) ?? OMITTED_DETAILS;
    replaced.details = dataProperty(logged);
    // Not enumerable: a key for the serializer, not a field of the error.
    replaced[LOGGED_DETAILS] = { value: logged, enumerable: false };
  }
  // `code` and `details` only as replaced above: without a code to give the
  // copy carries no `code` key, and neither serializer writes one.
  const {
    code: _code,
    details: _details,
    ...kept
  } = Object.getOwnPropertyDescriptors(err);
  const copy: object = Object.create(Object.getPrototypeOf(err), {
    ...kept,
    ...replaced,
  });
  return copy;
}

/**
 * The key every line of a request carries its id under. Fastify binds the id
 * to the logger of the request itself (`request.log`, `reply.log`) under the
 * label of the log controller, so the fields below do not repeat it: one id,
 * one name - the name the error body uses too - and no `reqId` next to it.
 */
const REQUEST_ID_LOG_LABEL = "requestId";

/**
 * What every line about one request says of it besides the id the logger of
 * the request binds (`REQUEST_ID_LOG_LABEL`): the method and the declared
 * route when the router got that far. Never the requested url - before the
 * password it is whatever the caller typed (docs/DECISIONS.md, Р1 and Р10
 * E0-11A).
 */
function requestFields(request: FastifyRequest): Record<string, unknown> {
  const routeUrl = request.routeOptions.url;
  return {
    method: request.method,
    ...(routeUrl === undefined ? {} : { routeUrl }),
  };
}

/**
 * The one shape of a line about a failure: what every line says of its
 * request, what the caller adds (`status`, `code`, `responseTime`) and the
 * error as the log may write it (`loggableError`).
 */
function failurePayload(
  request: FastifyRequest,
  err: unknown,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...requestFields(request), ...extra, err: loggableError(err) };
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
    (mapped.status < SERVER_ERROR_STATUS && request.authenticated !== true)
  ) {
    logRejection(request, mapped);
    return;
  }
  request.failureLogged = true;
  const payload = failurePayload(request, err, {
    status: mapped.status,
    code: mapped.code,
  });
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
  if (request.failureLogged === true) {
    return;
  }
  request.log.info(
    {
      ...requestFields(request),
      status: reply.statusCode,
      ...(request.authenticated === true ? { path: pathOf(request.url) } : {}),
      responseTime: reply.elapsedTime,
    },
    "request completed",
  );
}

/** The code Node gives a stream destroyed before it ended. */
const PREMATURE_CLOSE = "ERR_STREAM_PREMATURE_CLOSE";

/**
 * Whether a stream body failed only because the client went away. Node gives
 * the same code to a body of ours destroyed before it ended, which is a
 * failure of ours; the two are told apart by the socket - the client that
 * left has taken it down, while ours is still open when the body is cut
 * (Fastify destroys the response only after reporting it).
 *
 * The socket alone: `request.raw.aborted` is set by Node on the close of the
 * socket and says nothing the socket does not, and the socket of an HTTP/1
 * request is never taken off it. What the socket cannot say is who took it
 * down: a socket the server destroys itself - `requestTimeout`,
 * `connectionTimeout`, `forceCloseConnections` - reads as the client leaving,
 * and no public property tells the two apart. None of those options is set
 * by the api today (TECH_DEBT, E0-12Y).
 */
function clientWentAway(error: Error, request: FastifyRequest): boolean {
  return errorCode(error) === PREMATURE_CLOSE && request.raw.socket.destroyed;
}

/**
 * Fastify's own lines about a request, without the ones that carry the
 * requested url (Р10 E0-11A): the pair `incoming request` / `request
 * completed` goes, the lines about a response that broke, a stream or a
 * serializer that failed or an error handler that threw stay - at `error`,
 * with the error as the request log writes it (`loggableError`), without the
 * `req` object whose serializer writes the url.
 *
 * The access line is written here too: Fastify calls `requestCompleted` once
 * the `onResponse` hooks are done and hands it the error the response broke
 * with, which a hook never sees - so this is the one place that can tell a
 * completed request from a failed one.
 *
 * The rule of one line per request (Д1 E0-11A) has one named exception: a
 * line about a second failure - our error handler throwing
 * (`defaultErrorLog`), the head of the error response refused
 * (`writeHeadError`), its serializer throwing (`serializerError`) - is
 * written even when a line about the first one is there, since it tells what
 * the first line cannot (docs/DECISIONS.md, Т2 E0-12G). These three go
 * through `secondFailureLine`: they mark the request as told about and do not
 * read the mark. A response that broke on its way out (`requestCompleted`
 * with an error) and a stream that failed (`streamError`) go through
 * `failureLine` and are written only when no line about the failure of the
 * request is there yet.
 *
 * The id of the request is bound to its logger under `REQUEST_ID_LOG_LABEL`
 * (the controller hands Fastify the label), so it is in every line written
 * through `request.log` or `reply.log` without a field of its own.
 */
export class AccessLogController extends LogController {
  constructor() {
    super({ requestIdLogLabel: REQUEST_ID_LOG_LABEL });
  }

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
    failureLine(request, reply, error, "request errored");
  }

  /** Fastify's default error handler runs only when ours threw. */
  override defaultErrorLog(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    secondFailureLine(request, reply, error, "error handler failed");
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
    secondFailureLine(request, reply, error, "response head failed");
  }

  /**
   * A stream sent as the body failed after the head had gone out. A stream
   * the client stopped reading - the connection closed before the body was
   * done - is not a failure of ours: a short `info` line without the error.
   * It is the only line of the request: a response whose client left never
   * finishes, so Fastify never completes the request and no access line
   * follows. A body of ours cut short with the client still there is a
   * failure like any other (`clientWentAway`).
   */
  override streamError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (clientWentAway(error, request)) {
      // Told about: a failure of the response reported after this one
      // (`requestCompleted` with an error) writes no second line.
      request.failureLogged = true;
      reply.log.info(
        { ...requestFields(request), status: reply.statusCode },
        "stream closed prematurely",
      );
      return;
    }
    failureLine(request, reply, error, "response stream failed");
  }

  /** The serializer declared for the status of the error response threw. */
  override serializerError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    secondFailureLine(request, reply, error, "response serializer failed");
  }

  /** The not-found handler of the service writes its own line. */
  override routeNotFound(): void {}
}

/**
 * The way the controller writes a failure of the response itself: once per
 * request, at `error`, with what every line says of its request and the error
 * as the request log writes it.
 */
function failureLine(
  request: FastifyRequest,
  reply: FastifyReply,
  err: Error,
  msg: string,
): void {
  if (request.failureLogged === true) {
    return;
  }
  request.failureLogged = true;
  reply.log.error(
    failurePayload(request, err, {
      status: reply.statusCode,
      responseTime: reply.elapsedTime,
    }),
    msg,
  );
}

/**
 * A line about a second failure of the request - the named exception to the
 * rule of one line (see `AccessLogController`): written whether or not a line
 * about the first failure is there, and marking the request as told about so
 * no access line follows.
 */
function secondFailureLine(
  request: FastifyRequest,
  reply: FastifyReply,
  err: Error,
  msg: string,
): void {
  request.failureLogged = true;
  reply.log.error(
    failurePayload(request, err, {
      status: reply.statusCode,
      responseTime: reply.elapsedTime,
    }),
    msg,
  );
}
