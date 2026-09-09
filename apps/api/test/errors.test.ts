import {
  AppError,
  BudgetExceededError,
  NotFoundError,
  ValidationError,
} from "@sf/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "../src/app.js";
import type { AppInstance } from "../src/app.js";
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

/**
 * Routes that exist only here: the error handler is what is under test, and
 * the application has no handler whose job is to throw.
 */
function registerFailingRoutes(app: AppInstance): void {
  app.get(
    "/test/validated",
    { schema: { querystring: z.object({ limit: z.coerce.number().int() }) } },
    async (request) => ({ limit: request.query.limit }),
  );

  app.get("/test/not-found", async () => {
    throw new NotFoundError("idea 42 does not exist");
  });

  app.get("/test/leaky", async () => {
    // Exactly the shape docs/TECH_DEBT.md warns about: an upstream error
    // object handed to `details` as it is.
    throw new ValidationError("upstream rejected the request", {
      config: { url: LEAKED_URL },
    });
  });

  app.get("/test/budget", async () => {
    throw new BudgetExceededError("daily gemini budget spent", {
      provider: "gemini",
      spent: 5.25,
      cap: 5,
    });
  });

  app.get("/test/boom", async () => {
    throw new Error(INTERNAL_MESSAGE);
  });

  // A handler may throw anything at all, and the error handler is the last
  // thing standing between that value and the client.
  app.get("/test/thrown-string", async () => {
    throw THROWN_STRING;
  });

  app.get("/test/thrown-null", async () => {
    throw null;
  });

  app.get("/test/thrown-number", async () => {
    throw THROWN_NUMBER;
  });

  app.get("/test/upstream", async () => {
    // The shape E2/E7 will produce: a provider failure wrapped into a 5xx
    // AppError, message and all.
    throw new AppError("GEMINI_FAILED", `gemini rejected ${LEAKED_URL}`, 502);
  });

  app.get("/test/foreign-client-error", async () => {
    // The shape an http client rejects a response with: a plain `Error` with
    // a `statusCode` on it, and the request line - api key and all - as its
    // message.
    throw Object.assign(new Error(`GET ${LEAKED_URL} failed`), {
      statusCode: 403,
    });
  });

  app.get("/test/unlisted-status", async () => {
    // A 4xx nobody put in the code table, in the shape `@fastify/error`
    // builds: a status, an `FST_`-prefixed code and a message about the
    // request.
    throw Object.assign(new Error("nothing brews here"), {
      statusCode: 418,
      code: "FST_ERR_TEAPOT",
    });
  });

  app.get("/test/absurd-status", async () => {
    throw new AppError("WEIRD", "status nobody can send", 700);
  });

  app.get("/test/wordy", async () => {
    throw new AppError("WORDY", WORDY_MESSAGE, 409);
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

    // The status is the caller's to see, the plugin `code` is not, and the
    // text of a Fastify failure describes the request, so it travels.
    expect(res.statusCode).toBe(418);
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "CLIENT_ERROR",
      message: "nothing brews here",
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
  const lines: string[] = [];
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({
      routes: registerFailingRoutes,
      logger: {
        level: "trace",
        stream: {
          write: (line: string): void => {
            lines.push(line);
          },
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Everything written while one request was handled. */
  async function logOf(url: string): Promise<string> {
    lines.length = 0;
    await app.inject({
      method: "GET",
      url,
      headers: { authorization: AUTH_HEADER },
    });
    return lines.join("");
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

  it("writes the details a caller would have been shown anyway", async () => {
    const written = await logOf("/test/budget");

    expect(written).toContain("gemini");
    expect(written).not.toContain("[omitted]");
  });

  it("logs a request id and a rejection line for a url the router refused", async () => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url: BAD_URL });

    // A run of malformed urls is worth seeing; the router answers them on its
    // own and leaves nothing behind unless the reply goes through us.
    const written = lines.join("");
    expect(written).toContain(parseErrorBody(res.payload).error.requestId);
    expect(written).toContain("request rejected");
  });
});
