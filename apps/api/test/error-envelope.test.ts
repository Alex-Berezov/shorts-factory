import { REQUEST_ID_HEADER } from "@sf/contracts";
import { AppError, NotFoundError } from "@sf/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/app.js";
import {
  BAD_URL,
  BAD_URL_SUFFIX,
  ESCAPE,
  LINE_BREAK,
  THROWN_NUMBER,
  THROWN_STRING,
  registerFailingRoutes,
} from "./error-routes.js";
import { AUTH_HEADER, buildTestApp, parseErrorBody } from "./helpers.js";

/**
 * The envelope and the status of every failure the error handler answers.
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
