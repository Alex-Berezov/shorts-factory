import { BudgetExceededError, NotFoundError, ValidationError } from "@sf/core";
import { describe, expect, it } from "vitest";
import {
  BUDGET_EXCEEDED_ERROR_CODE,
  CLIENT_ERROR_CODES,
  ErrorBodySchema,
  NOT_FOUND_ERROR_CODE,
  VALIDATION_ERROR_CODE,
} from "../src/errors.js";

/** An envelope with everything the schema requires and nothing else. */
function envelope(): { error: Record<string, unknown> } {
  return {
    error: { code: "NOT_FOUND", message: "no such idea", requestId: "req-1" },
  };
}

describe("ErrorBodySchema", () => {
  it("accepts the envelope the API sends", () => {
    const parsed = ErrorBodySchema.parse(envelope());

    expect(parsed.error).toEqual({
      code: "NOT_FOUND",
      message: "no such idea",
      requestId: "req-1",
    });
  });

  it("leaves out details rather than reading them as undefined", () => {
    // The API omits the field when there is nothing a caller may see, and the
    // parsed value has to say the same: a key that exists with the value
    // `undefined` is a third state every client would have to handle.
    const parsed = ErrorBodySchema.parse(envelope());

    expect("details" in parsed.error).toBe(false);
  });

  it("keeps the details of a failure that has some", () => {
    const details = [{ path: "limit", message: "expected number" }];
    const parsed = ErrorBodySchema.parse({
      error: { ...envelope().error, details },
    });

    expect(parsed.error.details).toEqual(details);
  });

  it.each([
    ["no requestId", { code: "X", message: "m" }],
    ["an empty requestId", { code: "X", message: "m", requestId: "" }],
    ["no code", { message: "m", requestId: "req-1" }],
    ["a code that is not a string", { code: 7, message: "m", requestId: "r" }],
    ["no message", { code: "X", requestId: "req-1" }],
  ])("rejects an envelope with %s", (_name, error) => {
    // Without `requestId` the body cannot be tied to a log line, and a client
    // that parsed it would report a failure nobody can look up.
    expect(ErrorBodySchema.safeParse({ error }).success).toBe(false);
  });

  it("rejects a payload that is not an envelope at all", () => {
    expect(ErrorBodySchema.safeParse({ message: "nope" }).success).toBe(false);
    expect(ErrorBodySchema.safeParse("nope").success).toBe(false);
  });
});

describe("error codes", () => {
  it("names the domain failures the way their classes do", () => {
    // One source per code: the class and the constant are the same string, so
    // a client branching on the wire value and a job branching on the class
    // cannot drift apart.
    expect(new ValidationError("x").code).toBe(VALIDATION_ERROR_CODE);
    expect(new NotFoundError("x").code).toBe(NOT_FOUND_ERROR_CODE);
    expect(
      new BudgetExceededError("x", { provider: "gemini", spent: 1, cap: 1 })
        .code,
    ).toBe(BUDGET_EXCEEDED_ERROR_CODE);
  });

  it("reports a missing route under the domain code, not a second spelling", () => {
    expect(CLIENT_ERROR_CODES[404]).toBe(new NotFoundError("route").code);
  });

  it("gives every status of the table a distinct code", () => {
    const codes = Object.values(CLIENT_ERROR_CODES);

    expect(new Set(codes).size).toBe(codes.length);
  });
});
