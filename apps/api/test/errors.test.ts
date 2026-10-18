import { loadEnv } from "@sf/config";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import {
  AppError,
  BudgetExceededError,
  NotFoundError,
  ValidationError,
} from "@sf/core";
import { buildLoggerOptions } from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppInstance } from "../src/app.js";
import { errorResponses } from "../src/lib/route-schemas.js";
import { AUTH_HEADER, buildTestApp, parseErrorBody } from "./helpers.js";

/** A url with a secret in it, the way a provider error carries one. */
const LEAKED_URL = "https://www.googleapis.com/youtube/v3?key=super-secret-key";
/** Text that only exists inside the thrown error. */
const INTERNAL_MESSAGE = "connection to sf:hunter2@db failed";
/** A thrown value that is not an Error at all. */
const THROWN_STRING = "boom-string-secret";
/** The same, as a number: a handler may throw one of those too. */
const THROWN_NUMBER = 42;
/** A line break and a terminal escape, built by code point so that the
 * test source itself stays printable. */
const LINE_BREAK = String.fromCharCode(10);
const ESCAPE = String.fromCharCode(27);
/** A percent escape that decodes to nothing: the router rejects the url
 * before it looks for a route. */
const BAD_URL_SUFFIX = "%zz";
const BAD_URL = `/system/status${BAD_URL_SUFFIX}`;
/** Long, multi-line and with a terminal escape sequence in it. */
const WORDY_MESSAGE = `row rejected${LINE_BREAK}${ESCAPE}[31m${"very ".repeat(100)}long`;
/** A `code` built the way E2/E7 build one: from whatever the provider said. */
const WORDY_CODE = `TIMEOUT${LINE_BREAK}${ESCAPE}[31m${"UP".repeat(100)}`;
/** The same, short enough to read but still not an identifier. */
const SPACED_CODE = "connect ETIMEDOUT 142.250.1.1:443";
/** A `code` the size of a provider answer, with a forged second line. */
const HUGE_CODE = `${"A".repeat(10_000)}${LINE_BREAK}FORGED_LINE`;
/**
 * A short code padded with a run of blanks longer than the logged bound: one
 * line, once the run collapses into one space, and nothing to cut.
 */
const PADDED_CODE = `UPSTREAM${" ".repeat(300)}PADDED`;
/** The message of the error behind an `AppError`. */
const ROOT_CAUSE = "socket hang up at the root";
/** A code with a line break in it, left non-enumerable on the error. */
const HIDDEN_CODE = `UPSTREAM${LINE_BREAK}HIDDEN`;
/** A code nothing needs to be done to, but kept where pino does not look. */
const CLEAN_HIDDEN_CODE = "UPSTREAM_HIDDEN";
/** The same, behind a getter. */
const GETTER_CODE = "UPSTREAM_GETTER";
/** What an object put into `code` says when it is turned into text. */
const OBJECT_CODE_TEXT = "TEXT_OF_THE_THROWER";
/** A line separator, a next line and a no-break space: three characters a
 * range check on `0x20` lets through, `JSON.stringify` leaves as they are and
 * a reader of the resulting line breaks on. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const NEXT_LINE = String.fromCharCode(0x85);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
/** A code built from a provider answer that carried one of them. */
const SEPARATED_CODE = `TIMEOUT${LINE_SEPARATOR}UP`;
/** A message that carries all three. */
const SEPARATED_MESSAGE = `row${LINE_SEPARATOR}rejected${NEXT_LINE}here${NO_BREAK_SPACE}now`;

/**
 * Routes that exist only here: the error handler is what is under test, and
 * the application has no handler whose job is to throw.
 */
function registerFailingRoutes(app: AppInstance): void {
  // Declared exactly as the real routes declare them: with the wildcards of
  // `errorResponses()`, every answer below leaves through the zod serializer
  // instead of being written out as it is, so a shape the envelope schema
  // does not describe - `details` above all - fails here rather than in the
  // first epic that adds a route.
  const failing = { schema: { response: errorResponses() } };

  app.get(
    "/test/validated",
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int() }),
        response: {
          ...errorResponses(),
          200: z.object({ limit: z.number() }),
        },
      },
    },
    async (request) => ({ limit: request.query.limit }),
  );

  app.get("/test/not-found", failing, async () => {
    throw new NotFoundError("idea 42 does not exist");
  });

  app.get("/test/leaky", failing, async () => {
    // Exactly the shape docs/TECH_DEBT.md warns about: an upstream error
    // object handed to `details` as it is.
    throw new ValidationError("upstream rejected the request", {
      config: { url: LEAKED_URL },
    });
  });

  app.get("/test/budget", failing, async () => {
    throw new BudgetExceededError("daily gemini budget spent", {
      provider: "gemini",
      spent: 5.25,
      cap: 5,
    });
  });

  app.get("/test/boom", failing, async () => {
    throw new Error(INTERNAL_MESSAGE);
  });

  // A handler may throw anything at all, and the error handler is the last
  // thing standing between that value and the client.
  app.get("/test/thrown-string", failing, async () => {
    throw THROWN_STRING;
  });

  app.get("/test/thrown-null", failing, async () => {
    throw null;
  });

  app.get("/test/thrown-number", failing, async () => {
    throw THROWN_NUMBER;
  });

  app.get("/test/upstream", failing, async () => {
    // The shape E2/E7 will produce: a provider failure wrapped into a 5xx
    // AppError, message and all.
    throw new AppError("GEMINI_FAILED", `gemini rejected ${LEAKED_URL}`, 502);
  });

  app.get("/test/foreign-client-error", failing, async () => {
    // The shape an http client rejects a response with: a plain `Error` with
    // a `statusCode` on it, and the request line - api key and all - as its
    // message.
    throw Object.assign(new Error(`GET ${LEAKED_URL} failed`), {
      statusCode: 403,
    });
  });

  app.get("/test/unlisted-status", failing, async () => {
    // A 4xx nobody put in the code table, in the shape `@fastify/error`
    // builds: a status, an `FST_`-prefixed code and a message about the
    // request.
    throw Object.assign(new Error("nothing brews here"), {
      statusCode: 418,
      code: "FST_ERR_TEAPOT",
    });
  });

  app.get("/test/absurd-status", failing, async () => {
    throw new AppError("WEIRD", "status nobody can send", 700);
  });

  app.get("/test/wordy", failing, async () => {
    throw new AppError("WORDY", WORDY_MESSAGE, 409);
  });

  app.get("/test/wordy-code", failing, async () => {
    throw new AppError(WORDY_CODE, "upstream timed out", 502);
  });

  app.get("/test/spaced-code", failing, async () => {
    throw new AppError(SPACED_CODE, "upstream timed out", 502);
  });

  app.get("/test/separated-code", failing, async () => {
    throw new AppError(SEPARATED_CODE, "upstream timed out", 502);
  });

  app.get("/test/separated-message", failing, async () => {
    throw new AppError("SEPARATED", SEPARATED_MESSAGE, 409);
  });

  app.get("/test/client-spaced-code", failing, async () => {
    // A 4xx built the same careless way: the failure is the caller's, and the
    // `code` still came from a provider answer.
    throw new AppError(SPACED_CODE, "channel id is not a channel id", 400);
  });

  app.get("/test/leaked-url-code", failing, async () => {
    // The url of the failed call as the `code`: one token, no spaces, no
    // control characters and well under the length limit, so every bound but
    // the shape of an identifier lets it through with the key in it.
    throw new AppError(LEAKED_URL, "upstream rejected the call", 502);
  });

  app.get("/test/client-leaked-url-code", failing, async () => {
    throw new AppError(LEAKED_URL, "channel id is not a channel id", 400);
  });

  // A path parameter the router measures before it looks any further: one
  // over `maxParamLength` (100) is refused with 414 before auth runs.
  app.get("/test/param/:id", failing, async () => undefined);

  app.get("/test/insufficient-storage", failing, async () => {
    throw new AppError("DISK_FULL", "render volume is full", 507);
  });

  app.get("/test/phraseless-server-status", failing, async () => {
    throw new AppError("EDGE_FAILED", "nothing to say", 599);
  });

  app.get("/test/huge-code", failing, async () => {
    // Ten kilobytes of provider output with a line break in it, as `code`.
    throw new AppError(HUGE_CODE, "upstream answered with a novel", 502);
  });

  app.get("/test/padded-code", failing, async () => {
    throw new AppError(PADDED_CODE, "upstream answered with blanks", 502);
  });

  app.get("/test/caused", failing, async () => {
    // `details` filled by the thrower and a cause behind it: the two together
    // are what a `catch` around a provider call produces.
    throw Object.assign(
      new ValidationError("upstream rejected the request", {
        config: { url: LEAKED_URL },
      }),
      { cause: new Error(ROOT_CAUSE) },
    );
  });

  // `code` is typed `string`, but nothing stops a plain JavaScript caller or
  // a subclass from leaving something else in it, or from hiding it.
  app.get("/test/null-code", failing, async () => {
    const err = new AppError("PLACEHOLDER", "code went missing", 502);
    Object.defineProperty(err, "code", { value: null });
    throw err;
  });

  app.get("/test/numeric-code", failing, async () => {
    const err = new AppError("PLACEHOLDER", "code is a number", 502);
    Object.defineProperty(err, "code", { value: 503 });
    throw err;
  });

  app.get("/test/hidden-code", failing, async () => {
    const err = new AppError("PLACEHOLDER", "code is not enumerable", 502);
    Object.defineProperty(err, "code", {
      value: HIDDEN_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/clean-hidden-code", failing, async () => {
    const err = new AppError("PLACEHOLDER", "clean code, not enumerable", 502);
    Object.defineProperty(err, "code", {
      value: CLEAN_HIDDEN_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/getter-code", failing, async () => {
    const err = new AppError("PLACEHOLDER", "clean code behind a getter", 502);
    Object.defineProperty(err, "code", {
      get: (): string => GETTER_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/object-code", failing, async () => {
    // Turning this into text runs a function of the thrower's.
    const err = new AppError("PLACEHOLDER", "code is an object", 502);
    Object.defineProperty(err, "code", {
      value: { toString: (): string => OBJECT_CODE_TEXT },
    });
    throw err;
  });

  app.get("/test/foreign-server-error", failing, async () => {
    // The shape `@fastify/under-pressure` and http clients produce: a plain
    // error with a 5xx `statusCode`, a code of its own and an inside message.
    throw Object.assign(new Error(`overloaded, ${INTERNAL_MESSAGE}`), {
      statusCode: 503,
      code: "FST_UNDER_PRESSURE",
    });
  });

  app.get("/test/foreign-absurd-status", failing, async () => {
    throw Object.assign(new Error("redirect elsewhere"), { statusCode: 302 });
  });

  app.get("/test/phraseless-client-status", failing, async () => {
    throw Object.assign(new Error("client went away"), { statusCode: 499 });
  });
}

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

  it("answers a validation failure with 400 and the failed fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/validated?limit=nope",
      headers: authorized,
    });

    expect(res.statusCode).toBe(400);
    const { error } = parseErrorBody(res.payload);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toEqual([
      { path: "limit", message: expect.any(String) },
    ]);
  });

  it("puts the same request id in the body and in the header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/validated?limit=nope",
      headers: authorized,
    });

    const { error } = parseErrorBody(res.payload);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(error.requestId);
  });

  it("keeps a request id supplied by the caller", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/validated?limit=nope",
      headers: { ...authorized, [REQUEST_ID_HEADER]: "caller-correlation-id" },
    });

    expect(parseErrorBody(res.payload).error.requestId).toBe(
      "caller-correlation-id",
    );
    expect(res.headers[REQUEST_ID_HEADER]).toBe("caller-correlation-id");
  });

  it.each([
    ["far too long", "x".repeat(300)],
    ["carrying a line break", `first${LINE_BREAK}forged log line`],
    ["carrying an escape sequence", `${ESCAPE}[31mred`],
  ])(
    "replaces a request id %s with one of its own",
    async (_name, supplied) => {
      // The header is unauthenticated input on the public route, and its value
      // reaches every log line of the request, the response header and the error
      // body.
      const res = await app.inject({
        method: "GET",
        url: "/test/validated?limit=nope",
        headers: { ...authorized, [REQUEST_ID_HEADER]: supplied },
      });

      const { requestId } = parseErrorBody(res.payload).error;
      expect(requestId).not.toBe(supplied);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers[REQUEST_ID_HEADER]).toBe(requestId);
    },
  );

  it("answers an AppError with its own status and code", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/not-found",
      headers: authorized,
    });

    expect(res.statusCode).toBe(404);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "NOT_FOUND",
      message: "idea 42 does not exist",
    });
  });

  it("withholds AppError details that were never meant for a client", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/leaky",
      headers: authorized,
    });

    expect(res.statusCode).toBe(400);
    expect(parseErrorBody(res.payload).error.details).toBeUndefined();
    expect(res.payload).not.toContain("super-secret-key");
    expect(res.payload).not.toContain("googleapis");
  });

  it("passes through the three numbers of a budget failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/budget",
      headers: authorized,
    });

    expect(res.statusCode).toBe(429);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { provider: "gemini", spent: 5.25, cap: 5 },
    });
  });

  it("says nothing about an unexpected failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/boom",
      headers: authorized,
    });

    expect(res.statusCode).toBe(500);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal Server Error",
    });
    expect(res.payload).not.toContain("hunter2");
    expect(res.payload).not.toContain("stack");
    expect(res.payload).not.toContain("at Object");
  });

  it.each([
    ["/test/thrown-string", THROWN_STRING],
    ["/test/thrown-null", "null"],
    ["/test/thrown-number", String(THROWN_NUMBER)],
  ])("survives %s being thrown instead of an Error", async (url, thrown) => {
    // A guard that inspects the value with `in` throws on a primitive, and
    // that throw happens inside the error handler: Fastify then answers with
    // its own payload built from the thrown value, past every rule here.
    const res = await app.inject({ method: "GET", url, headers: authorized });

    expect(res.statusCode).toBe(500);
    const { error } = parseErrorBody(res.payload);
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal Server Error",
    });
    // The thrown value is looked for in the three fields the handler fills,
    // not in the raw payload: `requestId` is a random uuid, whose hex digits
    // contain any short decimal value often enough to fail a run that has
    // nothing wrong with it.
    expect(error.code).not.toContain(thrown);
    expect(error.message).not.toContain(thrown);
    expect(error.details).toBeUndefined();
  });

  it("keeps the status and the code of a 5xx AppError, not its text", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/upstream",
      headers: authorized,
    });

    // A caller has to tell "the provider is down, try later" from "we have a
    // bug", so the status and the code travel; the message does not, because
    // the message of a provider failure regularly carries the request url.
    expect(res.statusCode).toBe(502);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "GEMINI_FAILED",
      message: "Bad Gateway",
    });
    expect(res.payload).not.toContain("super-secret-key");
    expect(res.payload).not.toContain("googleapis");
  });

  it("says only the status of an error that merely looks like a 4xx", async () => {
    // `statusCode` on a plain object says nothing about who wrote the message:
    // an http client rejects a response with the same field, and its text is
    // the request line.
    const res = await app.inject({
      method: "GET",
      url: "/test/foreign-client-error",
      headers: authorized,
    });

    expect(res.statusCode).toBe(403);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "FORBIDDEN",
      message: "Forbidden",
    });
    expect(res.payload).not.toContain("super-secret-key");
    expect(res.payload).not.toContain("googleapis");
  });

  it("answers a 4xx status outside the code table", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/unlisted-status",
      headers: authorized,
    });

    // The status is the caller's to see; the plugin `code` is not, and
    // neither is its text - the messages `@fastify/error` builds are
    // templates with the caller input filled in, and this file's two other
    // handlers already refuse to echo input back.
    expect(res.statusCode).toBe(418);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "CLIENT_ERROR",
      message: "I'm a Teapot",
    });
    expect(res.payload).not.toContain("nothing brews here");
  });

  it("answers a parameter over the length limit with its own code and text", async () => {
    // The router raises 414 itself (`FST_ERR_MAX_PARAM_LENGTH`); the code and
    // the text have to name that failure, not the catch-all of the 4xx class.
    const res = await app.inject({
      method: "GET",
      url: `/test/param/${"x".repeat(200)}`,
    });

    expect(res.statusCode).toBe(414);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "URI_TOO_LONG",
      message: "URI Too Long",
    });
  });

  it("says the reason phrase of a 5xx status outside any table", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/insufficient-storage",
      headers: authorized,
    });

    expect(res.statusCode).toBe(507);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "DISK_FULL",
      message: "Insufficient Storage",
    });
  });

  it.each([
    [
      "5xx",
      "/test/phraseless-server-status",
      599,
      "EDGE_FAILED",
      "Internal Server Error",
    ],
    [
      "4xx",
      "/test/phraseless-client-status",
      499,
      "CLIENT_ERROR",
      "Request failed",
    ],
  ])(
    "says the class of a %s status that has no reason phrase",
    async (_name, url, status, code, message) => {
      const res = await app.inject({ method: "GET", url, headers: authorized });

      expect(res.statusCode).toBe(status);
      expect(parseErrorBody(res.payload).error).toMatchObject({
        code,
        message,
      });
    },
  );

  it("keeps the 5xx status of an error that is not ours, and nothing else of it", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/foreign-server-error",
      headers: authorized,
    });

    // 503 says "back off" to a balancer; collapsed into 500 it says "retry".
    expect(res.statusCode).toBe(503);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Service Unavailable",
    });
    expect(res.payload).not.toContain("FST_UNDER_PRESSURE");
    expect(res.payload).not.toContain("hunter2");
  });

  it("answers an error that is not ours with a status outside 4xx-5xx as an internal one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/foreign-absurd-status",
      headers: authorized,
    });

    expect(res.statusCode).toBe(500);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal Server Error",
    });
  });

  it("answers an AppError with an impossible status as an internal one", async () => {
    // `reply.status(700)` would throw inside the error handler itself.
    const res = await app.inject({
      method: "GET",
      url: "/test/absurd-status",
      headers: authorized,
    });

    expect(res.statusCode).toBe(500);
    expect(parseErrorBody(res.payload).error.code).toBe("INTERNAL_ERROR");
  });

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

  it("answers an unknown path in the same shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/no-such-route",
      headers: authorized,
    });

    expect(res.statusCode).toBe(404);
    const { error } = parseErrorBody(res.payload);
    expect(error.code).toBe("NOT_FOUND");
    // The same failure has a name in the domain as well: a rename that reaches
    // only one of the two shows up here rather than in a client.
    expect(error.code).toBe(new NotFoundError("route").code);
    // The path the caller typed is not echoed back into the body.
    expect(res.payload).not.toContain("no-such-route");
  });

  it("answers a url the router cannot parse in the same shape", async () => {
    // No credentials: this failure is raised by the router before it looks for
    // a route, so basic auth never runs - the reply has to be ours anyway.
    const res = await app.inject({ method: "GET", url: BAD_URL });

    expect(res.statusCode).toBe(400);
    const { error } = parseErrorBody(res.payload);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Bad Request");
    // Fastify's own answer to this one names the framework and repeats the
    // url; neither may reach the caller.
    expect(res.payload).not.toContain(BAD_URL_SUFFIX);
    expect(res.payload).not.toContain("FST_ERR");
    expect(res.headers[REQUEST_ID_HEADER]).toBe(error.requestId);
  });
});

/**
 * The log is the one place a failure is recorded in full - and the one place
 * where nobody is watching what ends up in it.
 */
describe("error log", () => {
  const recorder = recordingLogger();
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({
      routes: registerFailingRoutes,
      logger: recorder.log,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Everything written while one request was handled; with the password
   * unless a case is about the caller who has none.
   */
  async function logOf(
    url: string,
    headers: Record<string, string> = { authorization: AUTH_HEADER },
  ): Promise<string> {
    recorder.clear();
    await app.inject({ method: "GET", url, headers });
    return recorder.raw();
  }

  it("keeps the secret an AppError carried in details out of the log", async () => {
    const written = await logOf("/test/leaky");

    // The failure is written down - the response says nothing about it, so
    // this is the only record of what happened...
    expect(written).toContain("upstream rejected the request");
    // ...but `details` is filled by whoever throws, and `redact` covers header
    // paths only.
    expect(written).not.toContain("super-secret-key");
    expect(written).toContain("[omitted]");
  });

  /** The one line the error handler wrote for a request, parsed. */
  async function failureLineOf(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    await logOf(url, headers);
    // Every line of the request, not only the failure ones: an access line or
    // a second failure line next to it is exactly what must not be there.
    const written = recorder.entries();
    expect(written).toHaveLength(1);
    const entry: Record<string, unknown> = written[0] ?? {};
    expect(["request failed", "request rejected"]).toContain(entry.msg);
    return entry;
  }

  /** The levels by the name the decision uses, as the recorder writes them. */
  const LEVEL = { info: "info", warn: "warn", error: "error" } as const;

  it("writes a refused password as a short info line without the error", async () => {
    // Anyone on the published port can produce this one at any rate: a warn
    // with the whole error per attempt is what the real failures drown in.
    const entry = await failureLineOf("/test/boom?probe=caller-typed-text", {
      authorization: "Basic bm90OnRoZS1wYXNzd29yZA==",
    });

    expect(entry).toMatchObject({
      level: LEVEL.info,
      status: 401,
      code: "UNAUTHORIZED",
      method: "GET",
      routeUrl: "/test/boom",
    });
    expect(typeof entry.requestId).toBe("string");
    expect(entry.err).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("caller-typed-text");
  });

  it("writes a url the router refused as a short info line without the url", async () => {
    const entry = await failureLineOf(BAD_URL, {});

    expect(entry).toMatchObject({
      level: LEVEL.info,
      status: 400,
      code: "BAD_REQUEST",
      method: "GET",
    });
    expect(entry.err).toBeUndefined();
    expect(entry.routeUrl).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(BAD_URL_SUFFIX);
  });

  it("writes an unknown path tried with the password as a short info line", async () => {
    // A run of 404 from a client that has the password is worth seeing, and
    // used to leave nothing behind.
    const entry = await failureLineOf("/no-such-route-tried");

    expect(entry).toMatchObject({
      level: LEVEL.info,
      status: 404,
      code: "NOT_FOUND",
      method: "GET",
    });
    expect(entry.err).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("no-such-route-tried");
  });

  it("answers an unknown path without the password with 401 and its line", async () => {
    const entry = await failureLineOf("/no-such-route-tried", {});

    expect(entry).toMatchObject({ level: LEVEL.info, status: 401 });
    expect(JSON.stringify(entry)).not.toContain("no-such-route-tried");
  });

  it("writes a 4xx of a caller with the password as a warn with the error", async () => {
    const entry = await failureLineOf("/test/not-found");

    expect(entry).toMatchObject({ level: LEVEL.warn, status: 404 });
    expect(errOf(entry).type).toBe("NotFoundError");
  });

  it("writes a failure of ours as an error with the type and the stack", async () => {
    const entry = await failureLineOf("/test/boom");
    const err = errOf(entry);

    expect(entry).toMatchObject({
      level: LEVEL.error,
      status: 500,
      method: "GET",
      routeUrl: "/test/boom",
    });
    // The id is what ties this line to the client's report of the failure.
    expect(typeof entry.requestId).toBe("string");
    expect(err.type).toBe("Error");
    expect(String(err.stack)).toContain(`Error: ${INTERNAL_MESSAGE}`);
  });

  /** The `err` object of a parsed line, narrowed to read its fields. */
  function errOf(entry: Record<string, unknown>): Record<string, unknown> {
    const err = entry.err;
    expect(typeof err).toBe("object");
    return typeof err === "object" && err !== null ? { ...err } : {};
  }

  it("writes a code of any size as one bounded line", async () => {
    const entry = await failureLineOf("/test/huge-code");
    const code = errOf(entry).code;

    // The code that went out is the identifier; the one written down is the
    // original, cut to a line an operator can read.
    expect(entry.code).toBe("INTERNAL_ERROR");
    expect(typeof code).toBe("string");
    const logged = String(code);
    expect(logged.length).toBeLessThanOrEqual(259);
    expect(logged.startsWith("AAAA")).toBe(true);
    expect(logged.endsWith("...")).toBe(true);
    expect(logged).not.toContain(LINE_BREAK);
    expect(recorder.raw()).not.toContain("A".repeat(300));
  });

  it("bounds a code by the line it makes, not by the text it came from", async () => {
    // The bound is about what a reader gets: a run of blanks collapses first,
    // and a code that is short once collapsed is written whole.
    const entry = await failureLineOf("/test/padded-code");

    expect(errOf(entry).code).toBe("UPSTREAM PADDED");
  });

  it("answers and writes down an AppError whose code is not a string", async () => {
    recorder.clear();
    const res = await app.inject({
      method: "GET",
      url: "/test/null-code",
      headers: { authorization: AUTH_HEADER },
    });

    // Our envelope, not the payload of Fastify's own handler, which takes over
    // when ours throws.
    expect(res.statusCode).toBe(502);
    expect(parseErrorBody(res.payload).error.code).toBe("INTERNAL_ERROR");
    const entry = await failureLineOf("/test/null-code");
    expect(entry).toMatchObject({ level: LEVEL.error, status: 502 });
    expect(errOf(entry).code).toBe("null");
  });

  it("writes a numeric code as the number it is", async () => {
    const entry = await failureLineOf("/test/numeric-code");

    expect(errOf(entry).code).toBe("503");
  });

  it("writes a code the error kept out of its enumerable properties", async () => {
    const entry = await failureLineOf("/test/hidden-code");

    // pino walks the enumerable properties only: the bounded copy of the
    // code has to be one, whatever the original was.
    expect(errOf(entry).code).toBe("UPSTREAM HIDDEN");
  });

  it("writes a clean code the error kept out of its enumerable properties", async () => {
    const entry = await failureLineOf("/test/clean-hidden-code");

    expect(errOf(entry).code).toBe(CLEAN_HIDDEN_CODE);
  });

  it("writes a clean code the error keeps behind a getter", async () => {
    const entry = await failureLineOf("/test/getter-code");

    expect(errOf(entry).code).toBe(GETTER_CODE);
  });

  it("writes a code that is an object by its type, without running it", async () => {
    const entry = await failureLineOf("/test/object-code");

    expect(entry).toMatchObject({ level: LEVEL.error, status: 502 });
    expect(errOf(entry).code).toBe("[object]");
    expect(recorder.raw()).not.toContain(OBJECT_CODE_TEXT);
  });

  it("keeps the frames of the throw on an error whose details were replaced", async () => {
    const entry = await failureLineOf("/test/leaky");
    const stack = String(errOf(entry).stack);

    // The place the handler threw from, not only the name of the failure.
    expect(stack).toContain("upstream rejected the request");
    expect(stack).toMatch(/\n\s+at .*errors\.test\.ts:\d+:\d+/);
  });

  it("keeps the cause of an AppError whose details were replaced", async () => {
    const entry = await failureLineOf("/test/caused");
    const err = errOf(entry);

    // pino appends the chain of causes to the message and the stack of the
    // error it is given; a stand-in without the cause has no chain to append.
    expect(String(err.message)).toContain(ROOT_CAUSE);
    expect(String(err.stack)).toContain(`caused by: Error: ${ROOT_CAUSE}`);
    expect(err.type).toBe("ValidationError");
    expect(err.details).toBe("[omitted]");
    expect(recorder.raw()).not.toContain("super-secret-key");
  });

  it("writes the details a caller would have been shown anyway", async () => {
    const written = await logOf("/test/budget");

    expect(written).toContain("gemini");
    expect(written).not.toContain("[omitted]");
  });

  it("logs a request id and a rejection line for a url the router refused", async () => {
    recorder.clear();
    const res = await app.inject({ method: "GET", url: BAD_URL });

    // A run of malformed urls is worth seeing; the router answers them on its
    // own and leaves nothing behind unless the reply goes through us.
    const written = recorder.raw();
    expect(written).toContain(parseErrorBody(res.payload).error.requestId);
    expect(written).toContain("request rejected");
  });
});

/**
 * The one route that declares a status of its own on which the error handler
 * also answers: an exact key of `schema.response` wins over the wildcard for
 * the whole status, not for the happy path of it.
 */
describe("a failure on the route with a status of its own", () => {
  it("answers /health with the envelope, not with the health shape", async () => {
    const app = buildTestApp({
      health: {
        check: async () => {
          throw new AppError("DB_UNAVAILABLE", "postgres is gone", 503);
        },
      },
    });
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/health" });

      // Serialized against `{status}` this body does not fit, and Fastify
      // answers `FST_ERR_FAILED_ERROR_SERIALIZATION` with a 500 instead: no
      // envelope, no request id, the name of the framework on the one public
      // route, and a healthcheck reading an outage as a dead service.
      expect(res.statusCode).toBe(503);
      const { error } = parseErrorBody(res.payload);
      expect(error.code).toBe("DB_UNAVAILABLE");
      expect(error.requestId).toBe(res.headers[REQUEST_ID_HEADER]);
      expect(res.payload).not.toContain("FST_ERR");
    } finally {
      await app.close();
    }
  });
});

/**
 * The same error log on the logger the service really runs on
 * (`buildLoggerOptions` of `@sf/runtime`): its serializer writes a whitelist
 * of fields and never `details` itself - only what `loggableError` handed it
 * for the log. The cases above run on pino's own serializer, which writes
 * every field, so they cannot tell the two apart.
 */
describe("error log on the logger of the service", () => {
  const { transport: _unused, ...options } = buildLoggerOptions(
    loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://sf:sf@127.0.0.1:1/shorts_factory_none",
      REDIS_URL: "redis://127.0.0.1:1",
      ADMIN_PASSWORD: "testtest",
    }),
  );
  const recorder = recordingLogger(options);
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({
      routes: registerFailingRoutes,
      logger: recorder.log,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** The `err` of the one failure line a request wrote. */
  async function errOfRequest(url: string): Promise<Record<string, unknown>> {
    recorder.clear();
    await app.inject({
      method: "GET",
      url,
      headers: { authorization: AUTH_HEADER },
    });
    const line = recorder
      .entries()
      .find(
        (entry) =>
          entry.msg === "request failed" || entry.msg === "request rejected",
      );
    const err = line?.err;
    if (typeof err !== "object" || err === null) {
      throw new Error(`no failure line with an error for ${url}`);
    }
    return { ...err };
  }

  it("writes the details a caller was shown", async () => {
    const err = await errOfRequest("/test/budget");

    expect(err).toMatchObject({
      type: "BudgetExceededError",
      details: { provider: "gemini", spent: 5.25, cap: 5 },
    });
  });

  it("writes a marker for the details a caller was not shown, and not them", async () => {
    const err = await errOfRequest("/test/leaky");

    expect(err.details).toBe("[omitted]");
    expect(recorder.raw()).not.toContain("super-secret-key");
  });

  it("keeps the chain of causes in the message and the stack", async () => {
    const err = await errOfRequest("/test/caused");

    expect(String(err.message)).toContain(ROOT_CAUSE);
    expect(String(err.stack)).toContain(`caused by: Error: ${ROOT_CAUSE}`);
    expect(recorder.raw()).not.toContain("super-secret-key");
  });
});
