import { loadEnv } from "@sf/config";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/app.js";
import {
  BAD_URL,
  BAD_URL_SUFFIX,
  CLEAN_HIDDEN_CODE,
  GETTER_CODE,
  INTERNAL_MESSAGE,
  LINE_BREAK,
  OBJECT_CODE_TEXT,
  ROOT_CAUSE,
  registerFailingRoutes,
} from "./error-routes.js";
import {
  AUTH_HEADER,
  buildTestApp,
  parseErrorBody,
  recordingServiceLogger,
} from "./helpers.js";

/**
 * The log is the one place a failure is recorded in full - and the one place
 * where nobody is watching what ends up in it.
 */
describe("request log", () => {
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

    expect(entry).toMatchObject({
      level: LEVEL.warn,
      status: 404,
      method: "GET",
      routeUrl: "/test/not-found",
      requestId: expect.any(String),
    });
    expect(errOf(entry).type).toBe("NotFoundError");
  });

  it("names the request by one id under one key", async () => {
    const entry = await failureLineOf("/test/not-found");
    const raw = recorder.raw();

    // Parsed, a repeated key keeps its last value only: the count is read
    // off the text of the line.
    expect(raw.match(/"requestId"/g)).toHaveLength(1);
    expect(raw).not.toContain("reqId");
    expect(entry).not.toHaveProperty("reqId");
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
    // An absent code is not written as one: no `"null"` a reader would take
    // for a code somebody chose.
    expect(errOf(entry)).not.toHaveProperty("code");
    expect(recorder.raw()).not.toContain('"null"');
  });

  it.each(["/test/empty-code", "/test/blank-code"])(
    "writes no code for %s, a code that makes no line",
    async (url) => {
      const entry = await failureLineOf(url);

      expect(entry).toMatchObject({ level: LEVEL.error, status: 502 });
      // No `code: ""` a reader would take for a code somebody chose to leave
      // empty.
      expect(errOf(entry)).not.toHaveProperty("code");
    },
  );

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
    // The route of `error-routes.ts` that threw it.
    expect(stack).toMatch(/\n\s+at .*error-routes\.ts:\d+:\d+/);
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
    // The field itself: "gemini" is in the message of the failure too, so a
    // look at the whole line would pass with the details gone.
    const err = errOf(await failureLineOf("/test/budget"));

    expect(err.details).toEqual({ provider: "gemini", spent: 5.25, cap: 5 });
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
 * The same request log on the logger the service really runs on
 * (`buildLoggerOptions` of `@sf/runtime`): its serializer writes a whitelist
 * of fields and never `details` itself - only what `loggableError` handed it
 * for the log. The cases above run on pino's own serializer, which writes
 * every field, so they cannot tell the two apart.
 */
describe("request log on the logger of the service", () => {
  const recorder = recordingServiceLogger(
    loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://sf:sf@127.0.0.1:1/shorts_factory_none",
      REDIS_URL: "redis://127.0.0.1:1",
      ADMIN_PASSWORD: "testtest",
    }),
  );
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
