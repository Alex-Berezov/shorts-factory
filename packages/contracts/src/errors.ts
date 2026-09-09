import {
  BUDGET_EXCEEDED_ERROR_CODE,
  NOT_FOUND_ERROR_CODE,
  VALIDATION_ERROR_CODE,
} from "@sf/core";
import { z } from "zod";

/**
 * How an error code is written, and what a client may assume about one.
 *
 * A code is `UPPER_SNAKE`, carries no number and no version, and names the
 * failure rather than the place that raised it (`BUDGET_EXCEEDED`, not
 * `E1042`): the value is what a client branches on, and a numbering scheme
 * would have to be kept in step by hand across the API, its clients and the
 * documents.
 *
 * The set only grows. A code is added when a failure becomes worth telling
 * apart; it is never renamed - a rename is a silent break of every client that
 * branches on it - and never reused for a different failure, because a client
 * that learned the old meaning has no way of noticing. There is no version
 * field for the same reason: an old client meets a new code the way it meets
 * any code it does not know, and falls back to the status.
 *
 * That is also why `code` on the wire is `z.string()` rather than a closed
 * enum, and why this module is not the list of what can arrive. The codes
 * named here and in `@sf/core` are the ones the transport itself produces;
 * a failure raised by domain code carries whatever that code passed to
 * `AppError` (`GEMINI_FAILED` from an E2 provider call), and the API sends it
 * on as long as it is a usable identifier. So a client branches on the codes
 * it knows and treats every other one by status - a `switch` written as if
 * this file were exhaustive has a default case it will keep meeting.
 *
 * The domain codes live next to their classes in `@sf/core` and are
 * re-exported here; this module adds the ones that exist only on the
 * transport, where there is no domain error to name them.
 */
export {
  BUDGET_EXCEEDED_ERROR_CODE,
  NOT_FOUND_ERROR_CODE,
  VALIDATION_ERROR_CODE,
};

/** Code and message every unmapped failure is reported with. */
export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR";
export const INTERNAL_ERROR_MESSAGE = "Internal Server Error";
/** Code of a 4xx whose status is not in the table below. */
export const CLIENT_ERROR_CODE = "CLIENT_ERROR";

/**
 * Our code for each failure that describes the request rather than the
 * service. The failures Fastify and its plugins raise carry a code of their
 * own (`FST_BASIC_AUTH_MISSING_OR_BAD_AUTHORIZATION_HEADER`), and that code is
 * an implementation detail a client must not branch on - this table is what it
 * gets instead. 404 is the domain code: the same failure has a name in
 * `@sf/core`, and two spellings of it would drift apart.
 */
export const CLIENT_ERROR_CODES: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: NOT_FOUND_ERROR_CODE,
  405: "METHOD_NOT_ALLOWED",
  406: "NOT_ACCEPTABLE",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "TOO_MANY_REQUESTS",
};

/**
 * Correlation header, both incoming and outgoing. It is declared with the
 * error envelope because the two carry the same value: the `requestId` a
 * client reads out of the payload is what the header of that response says,
 * including on the failures the router answers before any hook of the service
 * runs.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/** One failed field, flattened so a client does not parse Zod internals. */
export const ErrorDetailItemSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ErrorDetailItem = z.infer<typeof ErrorDetailItemSchema>;

/**
 * The single failure shape of this API: every error - validation, domain,
 * plugin, unexpected - leaves through it, so a client parses one form and the
 * `requestId` in the body always matches the `x-request-id` header of the same
 * response.
 *
 * `details` is optional and `unknown`: what may be in it is decided per error
 * class by the service (the failed fields of a validation error, the three
 * numbers of a budget failure), and a failure with nothing to add leaves the
 * field out entirely rather than sending a third state for every client to
 * handle.
 */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;
