import {
  CLIENT_ERROR_CODE,
  CLIENT_ERROR_CODES,
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  REQUEST_ID_HEADER,
  VALIDATION_ERROR_CODE,
} from "@sf/contracts";
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
/** How much of an error message may travel to the caller. */
const MAX_MESSAGE_LENGTH = 200;
/** How long a code may be before it stops being an identifier. */
const MAX_CODE_LENGTH = 64;

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

/**
 * Everything that is not a character a body or a log line may carry: the
 * `C` classes (control, format, surrogate, private use, unassigned - `U+0085`
 * and the rest of the C1 set among them) and the `Z` classes, which hold every
 * separator there is (`U+2028`, `U+2029`) and every space that is not the
 * plain one (`U+00A0`).
 */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/** The one space that is a space: runs of it are collapsed, not replaced. */
const PLAIN_SPACE = " ";

/**
 * Printable, so an escape sequence cannot reach a terminal reading the body
 * and a line separator cannot split a log line in two.
 *
 * A range check (`>= 0x20 && !== 0x7f`) is not enough for either: `U+0085`,
 * `U+2028` and `U+00A0` all sit above it, `JSON.stringify` escapes none of
 * them, and a JavaScript reader of the resulting line breaks on the second.
 * The character classes state the rule once instead of listing code points.
 */
function isPrintable(char: string): boolean {
  return char === PLAIN_SPACE || !UNPRINTABLE.test(char);
}

/**
 * What of an error message may be shown to the caller.
 *
 * Only one source gets here - a 4xx `AppError` written by our own domain code
 * - and even that is bounded and flattened rather than passed through:
 * `AppError` is constructed from whatever a `catch` block had at hand, and an
 * unbounded multi-line string would go into a JSON body and into a log line
 * as it is.
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

/**
 * The written form of a code, as the convention in `@sf/contracts` states it:
 * `UPPER_SNAKE`, starting with a letter.
 *
 * Matching the shape is the whole test rather than one check among several,
 * because the things a code must not be do not share a character class. A url
 * a provider put in its error (`https://www.googleapis.com/youtube/v3?key=…`)
 * is one token, printable and under the length limit, so a filter built from
 * "not too long", "printable" and "no spaces" passes it on with the key in
 * it - proved by `test/errors.test.ts`, "refuses to send a code that is a url
 * with a key in it". An identifier is a narrow enough form to state directly.
 */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/**
 * What of an error code may be shown to the caller.
 *
 * The `code` of an `AppError` travels in both directions of the status range,
 * and it is built the same way its message is - `new AppError(String(err.code
 * ?? err.message), …, 502)` around a provider client is the shape E2 and E7
 * produce, so the field can arrive as a sentence, a url or a kilobyte of
 * provider output. A code is an identifier a client branches on, not prose:
 * it is either usable as it stands or it is not ours to send, so a value
 * outside the shape is replaced rather than trimmed - a truncated code would
 * name a different failure.
 *
 * What it is replaced with follows the status, not the direction of the
 * failure: a 4xx says what every other unnamed failure with that status says
 * (`CLIENT_ERROR_CODES`, `BAD_REQUEST` for a 400), so one status does not
 * reach a client under two different codes depending on what was thrown
 * inside. `INTERNAL_ERROR` on a 400 would tell the caller - and the retry
 * logic of a client - that the service broke, when the answer is that the
 * request did.
 */
function safeCode(code: unknown, status: number): string {
  const fallback = isClientStatus(status)
    ? (CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE)
    : INTERNAL_ERROR_CODE;
  if (
    typeof code !== "string" ||
    code.length > MAX_CODE_LENGTH ||
    !CODE_SHAPE.test(code)
  ) {
    return fallback;
  }
  return code;
}

/** Status of a Fastify or plugin error, read off a value of unknown shape. */
function readStatusCode(err: object): unknown {
  return "statusCode" in err ? err.statusCode : undefined;
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
        code: safeCode(err.code, err.httpStatus),
        message: statusMessage(err.httpStatus),
        details: undefined,
      };
    }
    return {
      status: err.httpStatus,
      code: safeCode(err.code, err.httpStatus),
      message: safeMessage(err.message, err.httpStatus),
      details: publicDetails(err),
    };
  }

  const status = readStatusCode(err);
  if (isClientStatus(status)) {
    return {
      status,
      code: CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE,
      // Nothing written outside our domain code is repeated back, whoever
      // wrote it: an http client rejects a response with the very same
      // `statusCode` field and the request line as its message, and the
      // messages `@fastify/error` builds are templates with the caller input
      // filled in (`'%s' is not a valid url component`) - echoing the input
      // is what the not-found handler and the router handler in this file
      // already refuse to do. The full error stays in the log with the
      // `requestId`.
      message: statusMessage(status),
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
