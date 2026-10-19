import { env } from "@sf/config";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import { AppError, ValidationError } from "@sf/core";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/app.js";
import { AccessLogController } from "../src/lib/error-log.js";
import {
  AUTH_HEADER,
  TEST_PASSWORD,
  basicAuthHeader,
  buildTestApp,
  recordingServiceLogger,
} from "./helpers.js";

/** Put into a url by the caller; must not reach any line of the log. */
const MARKER = "caller-typed-marker";

/** A provider url with a key, the way a thrower puts it into `details`. */
const LEAKED_URL = "https://www.googleapis.com/youtube/v3?key=super-secret-key";

/** What one request left behind: its parsed log lines and its id header. */
interface Written {
  entries: Record<string, unknown>[];
  raw: string;
  requestId: unknown;
}

/**
 * The access log of the service: one line per answered request, the path in
 * it only once the caller gave the password and the query string never -
 * before the password the url is whatever an anonymous client on the
 * published port typed, and after it the query is where tokens travel
 * (docs/DECISIONS.md, Р1, Р10, Д1 and Д2 E0-11A).
 */
describe("access log", () => {
  const recorder = recordingLogger();
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({
      logger: recorder.log,
      routes: (instance) => {
        // The socket under a response failing while it is being written: the
        // event Fastify reports to its log controller as a completed request
        // with an error. Only on a real socket - `inject` treats an error
        // on its fake response as a failure of the injection itself.
        instance.get("/test/broken-response", async (_request, reply) => {
          reply.raw.emit("error", new Error("socket went away mid-response"));
          return { ok: true };
        });
        // A failure our handler writes down, and then the response to it
        // breaking as well: two failures, one request, one line.
        // The socket fails as the error response is being sent, after the
        // error handler has written its line.
        instance.get(
          "/test/failed-then-broken",
          {
            onSend: (_request, reply, payload, done) => {
              reply.raw.emit("error", new Error("socket went away mid-error"));
              done(null, payload);
            },
          },
          async () => {
            throw new AppError("UPSTREAM_FAILED", "provider failed", 502);
          },
        );
        // A response broken by an error that carries what a thrower put into
        // `details` - the line about it obeys the rules of the error log.
        instance.get("/test/broken-with-details", async (_request, reply) => {
          reply.raw.emit(
            "error",
            new ValidationError("broken with details", {
              config: { url: LEAKED_URL },
            }),
          );
          return { ok: true };
        });
        // The head of an error response Node refused to write. Fastify gets
        // there only when two error handlers failed one after another, so
        // the controller is handed the failure directly, with the request and
        // the reply of a real route - twice, as a second failure of the same
        // request would be.
        instance.get("/test/head-failed", async (request, reply) => {
          const controller = new AccessLogController();
          const failure = new ValidationError("head refused", {
            config: { url: LEAKED_URL },
          });
          controller.writeHeadError(failure, request, reply);
          controller.writeHeadError(failure, request, reply);
          return { ok: true };
        });
        // A stream body and a serializer failing are reported to the
        // controller the same way, and are as hard to reach for real: each
        // is handed its failure directly, twice, like the head above.
        instance.get("/test/stream-failed", async (request, reply) => {
          const controller = new AccessLogController();
          const failure = new ValidationError("stream broke", {
            config: { url: LEAKED_URL },
          });
          controller.streamError(failure, request, reply);
          controller.streamError(failure, request, reply);
          return { ok: true };
        });
        instance.get("/test/serializer-failed", async (request, reply) => {
          const controller = new AccessLogController();
          const failure = new ValidationError("serializer threw", {
            config: { url: LEAKED_URL },
          });
          controller.serializerError(failure, request, reply);
          controller.serializerError(failure, request, reply);
          return { ok: true };
        });
        // An error our own handler cannot map: reading it throws, so the
        // handler throws, and Fastify's default handler takes the request.
        instance.get("/test/unmappable", async () => {
          const unmappable = new Error("unmappable failure");
          Object.defineProperty(unmappable, "validation", {
            get(): never {
              throw new Error("the error handler itself failed");
            },
          });
          throw unmappable;
        });
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Where the listening app is reached over a real socket. */
  function baseUrl(): string {
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server is not listening on a tcp port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** Every line written while one request was handled, parsed. */
  async function written(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<Written> {
    recorder.clear();
    const res = await app.inject({ method: "GET", url, headers });
    // Every line below is matched against this id, so it has to be one.
    expect(res.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    return {
      entries: recorder.entries(),
      raw: recorder.raw(),
      requestId: res.headers[REQUEST_ID_HEADER],
    };
  }

  it("writes nothing an anonymous caller put into the url", async () => {
    const { entries, raw, requestId } = await written(`/health?x=${MARKER}`);

    // The request is answered and written down, once...
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request completed",
        method: "GET",
        status: 200,
        routeUrl: "/health",
        requestId,
      }),
    ]);
    // ...but no line of it repeats what the caller typed, nor says where the
    // caller came from.
    expect(entries[0]).not.toHaveProperty("path");
    expect(raw).not.toContain(MARKER);
    expect(raw).not.toContain("remoteAddress");
  });

  it("writes the path of a caller who gave the password, not the query", async () => {
    // `/health` is public and never checks the password, so the caller who
    // proved who it is is seen on a protected route.
    const { entries, raw, requestId } = await written(
      `/system/status?token=${MARKER}`,
      { authorization: AUTH_HEADER },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request completed",
        method: "GET",
        status: 200,
        routeUrl: "/system/status",
        path: "/system/status",
        requestId,
        responseTime: expect.any(Number),
      }),
    ]);
    expect(raw).not.toContain(MARKER);
  });

  it("writes no query of a caller with the password on the public route", async () => {
    const { entries, raw } = await written(`/health?x=${MARKER}`, {
      authorization: AUTH_HEADER,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        msg: "request completed",
        routeUrl: "/health",
      }),
    ]);
    expect(raw).not.toContain(MARKER);
  });

  it("writes a wrong password on a protected route once, without the url", async () => {
    const { entries, raw, requestId } = await written(
      `/system/status?x=${MARKER}`,
      { authorization: basicAuthHeader("not-the-password") },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 401,
        code: "UNAUTHORIZED",
        routeUrl: "/system/status",
        requestId,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("err");
    expect(raw).not.toContain(MARKER);
  });

  it("writes a response that broke on its way out as an error with its stack", async () => {
    recorder.clear();
    const res = await fetch(`${baseUrl()}/test/broken-response`, {
      headers: { authorization: AUTH_HEADER },
    });
    await res.text();
    const entries = recorder.entries();
    const requestId = res.headers.get(REQUEST_ID_HEADER);
    expect(requestId).toEqual(expect.any(String));

    const failure = entries.find((e) => e.msg === "request errored");
    expect(failure).toMatchObject({
      level: "error",
      routeUrl: "/test/broken-response",
      requestId,
      err: {
        message: "socket went away mid-response",
        stack: expect.stringContaining("socket went away mid-response"),
      },
    });
    expect(entries.map((e) => e.msg)).not.toContain("request completed");
  });

  /** Every line written while one request was served over a real socket. */
  async function writtenOverSocket(path: string): Promise<Written> {
    recorder.clear();
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: { authorization: AUTH_HEADER },
    });
    await res.text();
    const requestId = res.headers.get(REQUEST_ID_HEADER);
    expect(requestId).toEqual(expect.any(String));
    return { entries: recorder.entries(), raw: recorder.raw(), requestId };
  }

  it("writes a failure whose response broke as well once", async () => {
    const { entries, requestId } = await writtenOverSocket(
      "/test/failed-then-broken",
    );

    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "request failed",
        status: 502,
        reqId: requestId,
      }),
    ]);
  });

  it("writes the error of a broken response the way the error log does", async () => {
    const { entries, raw, requestId } = await writtenOverSocket(
      "/test/broken-with-details",
    );

    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "request errored",
        requestId,
        err: expect.objectContaining({
          message: "broken with details",
          details: "[omitted]",
        }),
      }),
    ]);
    expect(raw).not.toContain("super-secret-key");
  });

  it("writes a response head that failed once, as an error, and no access line", async () => {
    const { entries, raw, requestId } = await written("/test/head-failed", {
      authorization: AUTH_HEADER,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "response head failed",
        routeUrl: "/test/head-failed",
        requestId,
        err: expect.objectContaining({
          message: "head refused",
          details: "[omitted]",
        }),
      }),
    ]);
    expect(raw).not.toContain("super-secret-key");
  });

  it.each([
    ["/test/stream-failed", "response stream failed", "stream broke"],
    [
      "/test/serializer-failed",
      "response serializer failed",
      "serializer threw",
    ],
  ])(
    "writes %s once, as an error, and no access line",
    async (path, msg, message) => {
      const { entries, raw, requestId } = await written(path, {
        authorization: AUTH_HEADER,
      });

      expect(entries).toEqual([
        expect.objectContaining({
          level: "error",
          msg,
          method: "GET",
          routeUrl: path,
          requestId,
          err: expect.objectContaining({ message, details: "[omitted]" }),
        }),
      ]);
      expect(raw).not.toContain("super-secret-key");
    },
  );

  it("writes the failure of the error handler itself, without the url", async () => {
    const { entries, raw, requestId } = await written(
      `/test/unmappable?x=${MARKER}`,
      { authorization: AUTH_HEADER },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "error handler failed",
        status: 500,
        routeUrl: "/test/unmappable",
        requestId,
        err: expect.objectContaining({
          message: "the error handler itself failed",
          stack: expect.stringContaining("the error handler itself failed"),
        }),
      }),
    ]);
    expect(raw).not.toContain(MARKER);
  });
});

/**
 * The credentials of a caller against the logger the service really runs
 * with (`buildLoggerOptions`, as `src/server.ts` builds it): basic auth puts
 * the only secret of the api into `authorization`, and no line of a request -
 * answered, refused or failed - may carry it. The case reads the lines, not
 * what keeps the header out of them: Fastify's request serializer writes no
 * headers under `req`, the `redact` of the shared logger covers the paths it
 * names (`packages/runtime/test/logger.test.ts`), and a line that put the
 * headers under a key of its own would pass both.
 */
describe("the credentials of a caller", () => {
  const recorder = recordingServiceLogger(env);
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp({
      logger: recorder.log,
      routes: (instance) => {
        instance.get("/test/fails", async () => {
          throw new Error("handler failed");
        });
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const REFUSED_PASSWORD = "not-the-password";

  it.each([
    ["answered", "/system/status", TEST_PASSWORD],
    ["refused", "/system/status", REFUSED_PASSWORD],
    ["failed", "/test/fails", TEST_PASSWORD],
  ])(
    "reach no line of a request that was %s",
    async (_outcome, url, password) => {
      const authorization = basicAuthHeader(password);
      recorder.clear();
      await app.inject({ method: "GET", url, headers: { authorization } });

      expect(recorder.entries().length).toBeGreaterThan(0);
      // Encoded as the client sent it, and decoded: a line that wrote what
      // the auth hook read out of the header would carry the password itself.
      for (const secret of [
        authorization.slice("Basic ".length),
        `admin:${password}`,
        password,
      ]) {
        expect(recorder.raw()).not.toContain(secret);
      }
    },
  );
});
