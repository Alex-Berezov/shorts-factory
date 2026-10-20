import { describe, expect, it } from "vitest";
import { errorCode } from "../src/domain/error-code.js";

describe("errorCode", () => {
  it("reads a code that is a string, and nothing else", () => {
    expect(
      errorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
    ).toBe("ECONNREFUSED");
    expect(errorCode({ code: "57014" })).toBe("57014");
    expect(
      errorCode(Object.assign(new Error("x"), { code: 42 })),
    ).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("57014")).toBeUndefined();
  });
});
