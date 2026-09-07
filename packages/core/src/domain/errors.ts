import type { Provider } from "./provider.js";

/**
 * Domain errors. The class - not a string field - is what callers branch on:
 * the Fastify error handler (E0-06) maps `AppError.httpStatus` to the response
 * code, and the worker (E0-09) refuses to retry a `BudgetExceededError`,
 * because a second attempt would spend money the cap already denied.
 *
 * The compile target is ES2022, so `extends Error` keeps the prototype chain
 * on its own and `Object.setPrototypeOf` is not needed; the `instanceof`
 * assertions in `test/errors.test.ts` guard that, since a downgrade of the
 * target would break every branch above silently.
 */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** Input that never had a chance of being valid - the caller is at fault. */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
  }
}

/** A row, file or external resource that is not there. */
export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super("NOT_FOUND", message, 404, details);
  }
}

/**
 * A cap of ours is reached. 429 rather than 402 because the call is not
 * forbidden, it is too early; `code` stays the way to tell our own budget
 * apart from a provider throttling us.
 */
export class BudgetExceededError extends AppError {
  /**
   * Narrower than `AppError.details`, so that the error handler (E0-06), the
   * `/system` view and the "do not retry" branch of E0-09 read the provider
   * instead of casting it out of `unknown`. `declare` only re-states the type:
   * the value is the one the base constructor stored, and a real field would
   * overwrite it under `useDefineForClassFields`.
   */
  declare readonly details: { provider: Provider; spent: number; cap: number };

  constructor(
    message: string,
    details: { provider: Provider; spent: number; cap: number },
  ) {
    super("BUDGET_EXCEEDED", message, 429, details);
  }
}
