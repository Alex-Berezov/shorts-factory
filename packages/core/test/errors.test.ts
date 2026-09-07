import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppError,
  BudgetExceededError,
  NotFoundError,
  ValidationError,
} from "../src/domain/errors.js";
import type { Provider } from "../src/domain/provider.js";

/**
 * The API error handler (E0-06) and the "do not retry" rule of E0-09 branch on
 * `instanceof`, which quietly stops working when the compile target drops
 * below ES2022 - hence an assertion per class rather than one on `AppError`.
 */
describe("domain errors", () => {
  const cases = [
    {
      name: "ValidationError",
      error: new ValidationError("bad input", { field: "spent" }),
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      details: { field: "spent" },
      message: "bad input",
    },
    {
      name: "NotFoundError",
      error: new NotFoundError("no such idea", { id: 7 }),
      code: "NOT_FOUND",
      httpStatus: 404,
      details: { id: 7 },
      message: "no such idea",
    },
    {
      name: "BudgetExceededError",
      error: new BudgetExceededError("daily cap reached", {
        provider: "youtube_data",
        spent: 10_000,
        cap: 10_000,
      }),
      code: "BUDGET_EXCEEDED",
      httpStatus: 429,
      details: { provider: "youtube_data", spent: 10_000, cap: 10_000 },
      message: "daily cap reached",
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("is an AppError and an Error", () => {
        expect(c.error).toBeInstanceOf(AppError);
        expect(c.error).toBeInstanceOf(Error);
      });

      it("carries its code, status and details", () => {
        expect(c.error.code).toBe(c.code);
        expect(c.error.httpStatus).toBe(c.httpStatus);
        expect(c.error.details).toEqual(c.details);
      });

      it("keeps the message and names itself after the class", () => {
        expect(c.error.message).toBe(c.message);
        expect(c.error.name).toBe(c.name);
        expect(c.error.stack).toContain(c.name);
      });
    });
  }

  it("tells its own subclasses apart", () => {
    expect(new ValidationError("x")).not.toBeInstanceOf(NotFoundError);
    expect(new NotFoundError("x")).not.toBeInstanceOf(BudgetExceededError);
  });

  it("leaves details undefined when the caller gives none", () => {
    expect(new ValidationError("no details").details).toBeUndefined();
  });

  it("names the provider of a budget error by the shared union", () => {
    // A free string here is how a typo reaches the DLQ and `/system`: the
    // operator reads a provider no aggregate ever sums.
    expectTypeOf<
      ConstructorParameters<typeof BudgetExceededError>[1]["provider"]
    >().toEqualTypeOf<Provider>();
  });

  it("hands a budget error's details out already typed", () => {
    // The error handler (E0-06) and `/system` read the provider off the error;
    // with `details: unknown` on the class they would have to cast it back, and
    // a cast is where a typo survives.
    const error = new BudgetExceededError("daily cap reached", {
      provider: "gemini",
      spent: 3,
      cap: 3,
    });

    expectTypeOf(error.details).toEqualTypeOf<{
      provider: Provider;
      spent: number;
      cap: number;
    }>();
    expect(error.details.provider).toBe("gemini");
  });

  it("keeps AppError usable on its own", () => {
    const error = new AppError("CUSTOM", "something else", 418);

    expect(error.name).toBe("AppError");
    expect(error.httpStatus).toBe(418);
  });
});
