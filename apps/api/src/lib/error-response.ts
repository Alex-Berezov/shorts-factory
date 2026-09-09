import type { ErrorBody, ErrorDetailItem } from "@sf/contracts";
import { type AppError, BudgetExceededError, ValidationError } from "@sf/core";
import { z } from "zod";

/**
 * What a caller of `buildErrorBody` has in hand. The wire shape itself -
 * `ErrorBody` - is declared in `@sf/contracts` and shared with the client;
 * this is the input side of it, where `details` is always stated and often
 * `undefined`.
 */
export interface ErrorBodyInput {
  code: string;
  message: string;
  requestId: string;
  /**
   * Required and often `undefined`: every caller states what it has, and the
   * decision what that means for the payload is made in one place below.
   */
  details: unknown;
}

/**
 * The one place that decides what an absent `details` looks like on the wire:
 * the field is attached only when there is something to attach.
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * property, and an explicit `"details": null` in the payload would make every
 * client handle a third state.
 */
export function buildErrorBody(input: ErrorBodyInput): ErrorBody {
  const { code, message, requestId } = input;
  if (input.details === undefined) {
    return { error: { code, message, requestId } };
  }
  return { error: { code, message, requestId, details: input.details } };
}

/**
 * Zod issues carry a path as an array of segments; the wire form is a dotted
 * string, and nothing else of the issue (input value, expected type) is
 * exposed - the value is what the caller sent, but it is also what an
 * upstream error object could have smuggled in.
 */
const IssueListSchema = z.array(
  z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  }),
);

/** Flattens Zod issues into the wire form; unknown shapes yield nothing. */
export function toDetailItems(issues: unknown): ErrorDetailItem[] | undefined {
  const parsed = IssueListSchema.safeParse(issues);
  if (!parsed.success || parsed.data.length === 0) {
    return undefined;
  }
  return parsed.data.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * What of `AppError.details` may leave the process.
 *
 * `details` is typed `unknown` and is filled by whoever throws, so
 * `catch (e) { throw new ValidationError(msg, e) }` around an HTTP client puts
 * a provider error - request url with the api key in it, request headers -
 * into the field (docs/TECH_DEBT.md, 07.09.2026). Serializing the field as it
 * is would publish that; instead each error class states what of it is
 * describable to a caller. The rest is not written down either - the log line
 * keeps a marker in place of the field (`logError` in
 * `src/plugins/error-handler.ts`), because the same value would reach the same
 * disk:
 *
 * - `ValidationError` - the list of failed fields, and only when `details`
 *   really is a list of issues;
 * - `BudgetExceededError` - the three numbers the caller needs to know when to
 *   retry, picked field by field rather than passed through;
 * - anything else - nothing.
 */
export function publicDetails(err: AppError): unknown {
  if (err instanceof BudgetExceededError) {
    const { provider, spent, cap } = err.details;
    return { provider, spent, cap };
  }
  if (err instanceof ValidationError) {
    return toDetailItems(err.details);
  }
  return undefined;
}
