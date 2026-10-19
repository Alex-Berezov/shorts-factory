import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/app.js";
import {
  ESCAPE,
  LINE_BREAK,
  LINE_SEPARATOR,
  NEXT_LINE,
  NO_BREAK_SPACE,
  SPACED_CODE,
  WORDY_CODE,
  registerFailingRoutes,
} from "./error-routes.js";
import { AUTH_HEADER, buildTestApp, parseErrorBody } from "./helpers.js";

/**
 * What the error handler makes of a code and a message it did not write:
 * bounded, flattened, and refused when no client could read it.
 */
describe("error handler", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({ routes: registerFailingRoutes });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const authorized = { authorization: AUTH_HEADER };

  it("bounds and flattens the message of a 4xx AppError", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/wordy",
      headers: authorized,
    });

    expect(res.statusCode).toBe(409);
    const { message } = parseErrorBody(res.payload).error;
    expect(message.length).toBeLessThanOrEqual(203);
    expect(message).not.toContain(LINE_BREAK);
    expect(message).not.toContain(ESCAPE);
    expect(message.startsWith("row rejected ")).toBe(true);
    expect(message.endsWith("...")).toBe(true);
  });

  it.each([
    ["multi-line and endless", "/test/wordy-code", WORDY_CODE],
    ["a sentence with an address in it", "/test/spaced-code", SPACED_CODE],
  ])(
    "refuses to send a 5xx code that is %s",
    async (_name, url, thrownCode) => {
      // `new AppError(String(err.code ?? err.message), …, 502)` is how a
      // provider failure becomes an `AppError` in E2/E7, so `code` arrives
      // built from the same untrusted text as the message - and unlike the
      // message it is not replaced by the status text on a 5xx.
      const res = await app.inject({ method: "GET", url, headers: authorized });

      expect(res.statusCode).toBe(502);
      const { error } = parseErrorBody(res.payload);
      // Replaced rather than trimmed: a cut-down code names another failure.
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(res.payload).not.toContain("TIMEOUT");
      expect(res.payload).not.toContain("142.250.1.1");
      expect(error.message).toBe("Bad Gateway");
    },
  );

  it("refuses a 5xx code carrying a separator a range check would miss", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/separated-code",
      headers: authorized,
    });

    expect(res.statusCode).toBe(502);
    expect(parseErrorBody(res.payload).error.code).toBe("INTERNAL_ERROR");
    expect(res.payload).not.toContain(LINE_SEPARATOR);
    expect(res.payload).not.toContain("TIMEOUT");
  });

  it("names a 4xx with an unusable code a client failure, not an internal one", async () => {
    // The status says the request is what went wrong; `INTERNAL_ERROR` on it
    // tells a client the service broke, and a client that believes it retries
    // a request that can never pass. The code is the one every other failure
    // with this status carries, not a second spelling of the same 400.
    const res = await app.inject({
      method: "GET",
      url: "/test/client-spaced-code",
      headers: authorized,
    });

    expect(res.statusCode).toBe(400);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "channel id is not a channel id",
    });
    expect(res.payload).not.toContain("142.250.1.1");
  });

  it.each([
    ["5xx", "/test/leaked-url-code", 502, "INTERNAL_ERROR"],
    ["4xx", "/test/client-leaked-url-code", 400, "BAD_REQUEST"],
  ])(
    "refuses to send a code that is a url with a key in it (%s)",
    async (_name, url, status, expectedCode) => {
      // The shape a provider failure of E2/E7 produces: `new AppError(
      // String(err.code ?? err.message), …)` where the client put the request
      // url into `code`. It is printable, has no spaces and is shorter than
      // the length limit, so nothing but the form of an identifier stops it -
      // and an api key in a response body is a leaked key.
      const res = await app.inject({ method: "GET", url, headers: authorized });

      expect(res.statusCode).toBe(status);
      expect(parseErrorBody(res.payload).error.code).toBe(expectedCode);
      expect(res.payload).not.toContain("super-secret-key");
      expect(res.payload).not.toContain("googleapis.com");
    },
  );

  it("flattens the separators of a message a range check would miss", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/separated-message",
      headers: authorized,
    });

    expect(res.statusCode).toBe(409);
    const { message } = parseErrorBody(res.payload).error;
    expect(message).toBe("row rejected here now");
    for (const char of [LINE_SEPARATOR, NEXT_LINE, NO_BREAK_SPACE]) {
      expect(message).not.toContain(char);
    }
  });
});
