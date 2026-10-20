import { describe, expect, it } from "vitest";
import { throwFailures } from "../src/failures.js";

/**
 * What a run with several failures ends in (`runMigrations`): no failure is
 * dropped, a single one keeps its identity (and its SQLSTATE), several come
 * together in the order given, and the message - what a stack trace at the
 * edge of the process shows - names each of them.
 */

/** What `throwFailures` threw, or that it returned. */
function outcomeOf(
  run: () => void,
): { thrown: false } | { thrown: true; error: unknown } {
  try {
    run();
  } catch (error) {
    return { thrown: true, error };
  }
  return { thrown: false };
}

describe("throwFailures", () => {
  it("returns when nothing failed", () => {
    expect(outcomeOf(() => throwFailures([]))).toEqual({ thrown: false });
  });

  it("throws a single failure as it is", () => {
    const failure = Object.assign(new Error("relation exists"), {
      code: "42710",
    });

    const outcome = outcomeOf(() => throwFailures([failure]));
    expect(outcome.thrown).toBe(true);
    expect(outcome.thrown && outcome.error).toBe(failure);
  });

  /** A thrown `undefined` is a failure too, not "nothing failed". */
  it("throws a single undefined rather than returning", () => {
    expect(outcomeOf(() => throwFailures([undefined]))).toEqual({
      thrown: true,
      error: undefined,
    });
  });

  it("throws several failures together, in order, each named with its code", () => {
    const primary = Object.assign(new Error("migration failed"), {
      code: "42710",
    });
    const unlock = new Error("releasing the migration lock failed: gone", {
      cause: Object.assign(new Error("gone"), { code: "08006" }),
    });
    const close = new Error("write CONNECTION_ENDED");

    const outcome = outcomeOf(() => throwFailures([primary, unlock, close]));

    expect(outcome.thrown).toBe(true);
    const error = outcome.thrown ? outcome.error : undefined;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      errors: [primary, unlock, close],
      message:
        "3 failures: migration failed [42710]; releasing the migration lock failed: gone [08006]; write CONNECTION_ENDED",
    });
  });

  it("keeps a value that is not an error among several", () => {
    const close = new Error("write CONNECTION_ENDED");

    const outcome = outcomeOf(() => throwFailures([undefined, close]));

    expect(outcome.thrown && outcome.error).toMatchObject({
      errors: [undefined, close],
      message: "2 failures: undefined; write CONNECTION_ENDED",
    });
  });
});
