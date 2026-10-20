import { STATUS_CODES } from "node:http";
import {
  CLIENT_ERROR_CODE,
  CLIENT_ERROR_CODES,
  INTERNAL_ERROR_CODE,
  VALIDATION_ERROR_CODE,
} from "@sf/contracts";
import { AppError } from "@sf/core";
import type { FastifyError } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { publicDetails, toDetailItems } from "./error-response.js";
import { safeCode, safeMessage } from "./error-text.js";
import {
  CLIENT_ERROR_STATUS,
  type MappedError,
  SERVER_ERROR_STATUS,
} from "./mapped-error.js";

/** Highest status code an HTTP response can carry. */
const MAX_ERROR_STATUS = 599;
/** Said instead of a 4xx message when the status has no reason phrase. */
const CLIENT_ERROR_MESSAGE = "Request failed";
/**
 * Said instead of a 5xx message when the status has no reason phrase: the
 * phrase of 500 itself, from the table every other status is read from. Node
 * has had it on every release; the fallback is there for the type only.
 */
const INTERNAL_ERROR_MESSAGE =
  STATUS_CODES[SERVER_ERROR_STATUS] ?? INTERNAL_ERROR_CODE;

/**
 * What a request that arrives while the service is closing is answered with
 * (`plugins/closing.ts`): a 503 through the error handler, so it carries the
 * envelope and the request id of every other response (docs/DECISIONS.md,
 * 11.10.2026, decision R-a of E0-11B). The status alone makes it
 * `INTERNAL_ERROR` / "Service Unavailable" in `mapError` (decision R2 of
 * E0-11A); no code of its own.
 *
 * Not a failure of the service either: the request log writes it as the short
 * line of a refused request (`logError` in `lib/request-log.ts`).
 */
export class ServiceClosingError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Service Unavailable");
    this.name = "ServiceClosingError";
  }
}

/**
 * The text sent when the message of the error itself may not be repeated: an
 * error built outside this service (4xx) or any failure of ours (5xx). Says
 * the status and nothing about what happened inside.
 *
 * The text is the standard reason phrase of the status (`STATUS_CODES` of
 * `node:http`) rather than a table of our own: a table kept next to
 * `CLIENT_ERROR_CODES` had to be extended by hand for every status, and the
 * one it missed (414, 507) went out with the text of another status. A status
 * with no phrase at all (499, 599) says its class.
 */
function statusMessage(status: number): string {
  return (
    STATUS_CODES[status] ??
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
 * The answer to a 4xx nothing of ours named: the code of its status from
 * `CLIENT_ERROR_CODES` and the reason phrase, nothing of the error behind it.
 * One factory for every such source - a status a plugin or a client library
 * put on its error, the router's own refusal, a request Node refused on the
 * socket and a path nobody declared - so the rule for their code and text is
 * written once.
 */
export function clientError(status: number): MappedError {
  return {
    status,
    code: CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE,
    message: statusMessage(status),
    details: undefined,
  };
}

/**
 * The answer to a 5xx nothing of ours named, and to everything not recognised
 * at all: the status, `INTERNAL_ERROR` and the reason phrase - no code, no
 * message, nothing of the original error. The counterpart of `clientError`
 * for the failures that are ours.
 */
function serverError(status: number): MappedError {
  return {
    status,
    code: INTERNAL_ERROR_CODE,
    message: statusMessage(status),
    details: undefined,
  };
}

/** The generic answer: `serverError` of 500. */
function internalError(): MappedError {
  return serverError(SERVER_ERROR_STATUS);
}

/**
 * The code a value outside the identifier shape is replaced with
 * (`safeCode`). It follows the status, not the direction of the failure: a
 * 4xx says what every other unnamed failure with that status says
 * (`CLIENT_ERROR_CODES`, `BAD_REQUEST` for a 400), so one status does not
 * reach a client under two different codes depending on what was thrown
 * inside. `INTERNAL_ERROR` on a 400 would tell the caller - and the retry
 * logic of a client - that the service broke, when the answer is that the
 * request did.
 */
function codeFallback(status: number): string {
  return isClientStatus(status)
    ? (CLIENT_ERROR_CODES[status] ?? CLIENT_ERROR_CODE)
    : INTERNAL_ERROR_CODE;
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
export function mapError(err: unknown): MappedError {
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
        code: safeCode(err.code, codeFallback(err.httpStatus)),
        message: statusMessage(err.httpStatus),
        details: undefined,
      };
    }
    return {
      status: err.httpStatus,
      code: safeCode(err.code, codeFallback(err.httpStatus)),
      message: safeMessage(err.message, statusMessage(err.httpStatus)),
      details: publicDetails(err),
    };
  }

  const status = readStatusCode(err);
  if (isClientStatus(status)) {
    // Nothing written outside our domain code is repeated back, whoever
    // wrote it: an http client rejects a response with the very same
    // `statusCode` field and the request line as its message, and the
    // messages `@fastify/error` builds are templates with the caller input
    // filled in (`'%s' is not a valid url component`) - echoing the input
    // is what the not-found handler and the router handler in
    // `plugins/error-handler.ts` already refuse to do. The full error stays
    // in the log with the `requestId`.
    return clientError(status);
  }

  // A 5xx keeps its status too - `@fastify/under-pressure` answers overload
  // with 503, and a balancer reads 503 as "back off" where 500 says "retry" -
  // but nothing else of the error leaves: the code a plugin or a client
  // library put on it is an implementation detail (`FST_UNDER_PRESSURE`) or
  // worse, so it becomes `INTERNAL_ERROR`, and the text is the reason phrase.
  // The asymmetry with a 4xx, which gets the code of its status from
  // `CLIENT_ERROR_CODES`, is deliberate: a 4xx names what the caller did, a
  // 5xx only says the failure was ours and how long it may last.
  if (isErrorStatus(status)) {
    return serverError(status);
  }

  return internalError();
}

/**
 * The failures the router raises before a route is matched (`fastify.js:645-708`):
 * a url that does not decode (`FST_ERR_BAD_URL`, 400), a path parameter over the
 * length limit (`FST_ERR_MAX_PARAM_LENGTH`, 414) and a constraint check throwing
 * instead of resolving (`FST_ERR_ASYNC_CONSTRAINT`) - the third has no client
 * status of its own and falls through `isClientStatus` into `internalError()`.
 * A request whose `accept-version` matches no route does not reach this
 * mapping at all: the router treats it as no match and hands it to
 * `setNotFoundHandler` (404), the same as any other unknown path.
 *
 * The text of the first two is a template with the caller input filled in
 * (`'%s' is not a valid url component`), so only the status class is repeated
 * back - the same rule the not-found handler follows, and for the same reason:
 * the value in the url is whatever the caller typed.
 */
export function mapFrameworkError(err: FastifyError): MappedError {
  const status = err.statusCode;
  if (!isClientStatus(status)) {
    return internalError();
  }
  return clientError(status);
}
