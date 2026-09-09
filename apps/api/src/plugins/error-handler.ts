import { AppError } from "@sf/core";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import {
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  REQUEST_ID_HEADER,
  VALIDATION_ERROR_CODE,
  buildErrorBody,
  publicDetails,
  toDetailItems,
} from "../lib/error-response.js";

/** Lowest status code that means "our fault", not the caller's. */
const SERVER_ERROR_STATUS = 500;
/** Lowest status code that describes the request rather than the service. */
const CLIENT_ERROR_STATUS = 400;
/** Highest status code an HTTP response can carry. */
const MAX_ERROR_STATUS = 599;
/** Said instead of a message that turned out to be unusable. */
const CLIENT_ERROR_MESSAGE = "Request failed";
/** Code of a 4xx whose status is not in the table below. */
const CLIENT_ERROR_CODE = "CLIENT_ERROR";
/** How much of an error message may travel to the caller. */
const MAX_MESSAGE_LENGTH = 200;

/**
 * Our codes for the failures raised by Fastify itself and by its plugins:
 * they carry a status and a human message, but their `code`
 * (`FST_BASIC_AUTH_MISSING_OR_BAD_AUTHORIZATION_HEADER`) is an implementation
 * detail a client should not branch on.
 */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  406: "NOT_ACCEPTABLE",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "TOO_MANY_REQUESTS",
};

/**
 * The text sent when the message of the error itself may not be repeated:
 * an error built outside this service (4xx) or any failure of ours (5xx).
 * Says the status class and nothing about what happened inside.
 */
const STATUS_MESSAGES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: INTERNAL_ERROR_MESSAGE,
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** Status of the route nobody declared, shared by the two handlers below. */
const NOT_FOUND_STATUS = 404;

interface MappedError {
  status: number;
  code: string;
  message: string;
  /** `undefined` when there is nothing a caller may see. */
  details: unknown;
}

/** The generic answer: no code, no message, nothing of the original error. */
function internalError(): MappedError {
  return {
    status: SERVER_ERROR_STATUS,
    code: INTERNAL_ERROR_CODE,
    message: INTERNAL_ERROR_MESSAGE,
    details: undefined,
  };
}

/** Neutral text for a status, for when the original one may not be repeated. */
function statusMessage(status: number): string {
  return (
    STATUS_MESSAGES[status] ??
    (status >= SERVER_ERROR_STATUS
      ? INTERNAL_ERROR_MESSAGE
      : CLIENT_ERROR_MESSAGE)
  );
}

/**
 * Whether a status may be sent as it was asked for: an integer in the 4xx or
 * 5xx range. Everything else - a 3xx, and the `0`, `700` or `NaN` a hand-built
 * error can carry - is answered as an internal failure, which also keeps
 * `reply.status()` from throwing `ERR_HTTP_INVALID_STATUS_CODE` inside the
 * error handler itself.
 */
function isErrorStatus(status: unknown): status is number {
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= CLIENT_ERROR_STATUS &&
    status <= MAX_ERROR_STATUS
  );
}

/** Whether a status describes the request rather than the service. */
function isClientStatus(status: unknown): status is number {
  return isErrorStatus(status) && status < SERVER_ERROR_STATUS;
}

/** Printable, so an escape sequence cannot reach a terminal reading the body. */
function isPrintable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

/**
 * What of an error message may be shown to the caller.
 *
 * Only messages from a known source get here - a 4xx `AppError` written by our
 * own domain code, or a failure Fastify and its plugins built - and even those
 * are bounded and flattened rather than passed through: `AppError` is
 * constructed from whatever a `catch` block had at hand, and an unbounded
 * multi-line string would go into a JSON body and into a log line as it is.
 */
function safeMessage(message: unknown, status: number): string {
  if (typeof message !== "string") {
    return statusMessage(status);
  }
  const printable = Array.from(message)
    .map((char) => (isPrintable(char) ? char : " "))
    .join("");
  const collapsed = printable.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return statusMessage(status);
  }
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}...`
    : collapsed;
}

/** Status of a Fastify or plugin error, read off a value of unknown shape. */
function readStatusCode(err: object): unknown {
  return "statusCode" in err ? err.statusCode : undefined;
}

/** Message of a value of unknown shape; `Error.message` is not enumerable. */
function readMessage(err: object): unknown {
  return "message" in err ? err.message : undefined;
}

/** The shape of a `code` on an error Fastify or one of its plugins built. */
const FASTIFY_ERROR_CODE = /^FST_[A-Z0-9_]+$/;

/**
 * Whether the text of this error was written by Fastify or one of its plugins.
 *
 * `statusCode` alone says nothing about where an object came from: an http
 * client rejects a response with the very same field, and its message is the
 * request line - `GET https://…/videos?key=… failed`. Only the errors built by
 * `@fastify/error` carry an `FST_`-prefixed code, and only those describe the
 * request instead of the call we made on behalf of it.
 */
function isFastifyError(err: object): boolean {
  const code = "code" in err ? err.code : undefined;
  return typeof code === "string" && FASTIFY_ERROR_CODE.test(code);
}

/**
 * Turns whatever was thrown into the status, code and message that go on the
 * wire. Everything not recognised is an internal error: a stack trace, an
 * SQL statement or a provider message in the response body tells an attacker
 * about the inside of the service and tells the caller nothing useful.
 */
function mapError(err: unknown): MappedError {
  // A handler can throw anything, not only an `Error`: `throw "boom"` arrives
  // here as a string, and the guards below inspect their argument with `in`,
  // which throws on a primitive. That throw would happen inside the error
  // handler, and Fastify would then answer with its own payload built from the
  // thrown value - past every rule in this file.
  if (typeof err !== "object" || err === null) {
    return internalError();
  }

  // The zod type provider wraps issues into its own error, so the request
  // validation failure never arrives here as a `ZodError`. A bare `ZodError`
  // is not a client failure at all - it comes from parsing something we read
  // ourselves - and falls through to the internal answer below.
  if (hasZodFastifySchemaValidationErrors(err)) {
    const issues = err.validation.map((entry) => entry.params.issue);
    return {
      status: CLIENT_ERROR_STATUS,
      code: VALIDATION_ERROR_CODE,
      message: "Request validation failed",
      details: toDetailItems(issues),
    };
  }

  // A response that does not match its own schema is our bug, not the
  // caller's input - it must not be reported as a validation failure.
  if (isResponseSerializationError(err)) {
    return internalError();
  }

  if (err instanceof AppError) {
    if (!isErrorStatus(err.httpStatus)) {
      return internalError();
    }
    // Status and code travel in both directions of the range: they are the
    // contract a client branches on, and `new AppError("YT_UNAVAILABLE", …,
    // 503)` has to stay distinguishable from a bug of ours. The message does
    // not: a 5xx `AppError` regularly carries a provider message a `catch`
    // block passed on - `new AppError("GEMINI_FAILED", err.message, 502)`
    // would hand the caller a request url with an api key in it, which is
    // exactly what the details whitelist exists for.
    if (!isClientStatus(err.httpStatus)) {
      return {
        status: err.httpStatus,
        code: err.code,
        message: statusMessage(err.httpStatus),
        details: undefined,
      };
    }
    return {
      status: err.httpStatus,
      code: err.code,
      message: safeMessage(err.message, err.httpStatus),
      details: publicDetails(err),
    };
  }

  const status = readStatusCode(err);
  if (isClientStatus(status)) {
    return {
      status,
      code: CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE,
      // Anything that merely looks like an http error - an http client's
      // rejected response, a hand-assembled object - states its status and
      // nothing else.
      message: isFastifyError(err)
        ? safeMessage(readMessage(err), status)
        : statusMessage(status),
      details: undefined,
    };
  }

  return internalError();
}

/** Stands in for `AppError.details` the log does not repeat verbatim. */
const OMITTED_DETAILS = "[omitted]";

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
 * the field was there.
 */
function loggableError(err: unknown): unknown {
  if (!(err instanceof AppError) || err.details === undefined) {
    return err;
  }
  // A plain object, not the error: pino writes the value it is given, and the
  // field has to be replaced rather than hidden behind a serializer.
  return {
    name: err.name,
    code: err.code,
    httpStatus: err.httpStatus,
    message: err.message,
    stack: err.stack,
    details: publicDetails(err) ?? OMITTED_DETAILS,
  };
}

function logError(
  request: FastifyRequest,
  err: unknown,
  mapped: MappedError,
): void {
  const payload = {
    err: loggableError(err),
    status: mapped.status,
    code: mapped.code,
  };
  if (mapped.status >= SERVER_ERROR_STATUS) {
    request.log.error(payload, "request failed");
    return;
  }
  request.log.warn(payload, "request rejected");
}

/**
 * The failures the router raises before a route is matched (`fastify.js:645-708`):
 * a url that does not decode (`FST_ERR_BAD_URL`, 400), a path parameter over the
 * length limit (`FST_ERR_MAX_PARAM_LENGTH`, 414) and a constraint check throwing
 * instead of resolving (`FST_ERR_ASYNC_CONSTRAINT`) - the third has no client
 * status of its own and falls through `isClientStatus` into `internalError()`.
 * A request whose `accept-version` matches no route does not reach this
 * handler at all: the router treats it as no match and hands it to
 * `setNotFoundHandler` (404), the same as any other unknown path.
 *
 * The text of the first two is a template with the caller input filled in
 * (`'%s' is not a valid url component`), so only the status class is repeated
 * back - the same rule the not-found handler follows, and for the same reason:
 * the value in the url is whatever the caller typed.
 */
function mapFrameworkError(err: FastifyError): MappedError {
  const status = err.statusCode;
  if (!isClientStatus(status)) {
    return internalError();
  }
  return {
    status,
    code: CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE,
    message: statusMessage(status),
    details: undefined,
  };
}

/**
 * The router's own answer, in the shape of every other failure of this API.
 *
 * Without it Fastify replies to a malformed url itself, and that reply is
 * outside everything this file and `buildApp` set up: Fastify's payload shape
 * instead of ours, no `requestId`, no `x-request-id` header, no basic auth in
 * front of it and no line in the log - an anonymous caller gets back its own
 * url and the name of the framework, and a run of malformed requests leaves no
 * trace.
 *
 * The request and the reply here are built by the router on the server-wide
 * context (`fastify.js`, `onBadUrl`), not on a route, so the `onSend` hook of
 * `buildApp` never runs for this reply: the correlation header is set by hand.
 */
export function frameworkErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const mapped = mapFrameworkError(err);
  logError(request, err, mapped);

  reply
    .header(REQUEST_ID_HEADER, request.id)
    .status(mapped.status)
    .send(
      buildErrorBody({
        code: mapped.code,
        message: mapped.message,
        requestId: request.id,
        details: mapped.details,
      }),
    );
}

/**
 * One error shape for the whole API, including the routes no epic wrote:
 * an unknown path answers like every other failure, so a client never has to
 * tell a Fastify payload apart from ours.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    const mapped = mapError(err);
    logError(request, err, mapped);

    reply.status(mapped.status).send(
      buildErrorBody({
        code: mapped.code,
        message: mapped.message,
        requestId: request.id,
        details: mapped.details,
      }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    // Code and text come from the same two tables as every other 4xx, and the
    // path is not echoed back: the body would then carry whatever the caller
    // typed into the url.
    reply.status(NOT_FOUND_STATUS).send(
      buildErrorBody({
        code: CLIENT_ERROR_CODES[NOT_FOUND_STATUS] ?? CLIENT_ERROR_CODE,
        message: statusMessage(NOT_FOUND_STATUS),
        requestId: request.id,
        details: undefined,
      }),
    );
  });
}
