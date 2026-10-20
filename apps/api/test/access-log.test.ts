import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { env } from "@sf/config";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import { AppError, ValidationError } from "@sf/core";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";
import type { AppInstance } from "../src/app.js";
import { LINE_BREAK } from "./error-routes.js";
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

/**
 * An error our own handler cannot map: reading it throws, so the handler
 * throws, and Fastify's default handler takes the request.
 */
function unmappableError(): Error {
  const unmappable = new Error("unmappable failure");
  Object.defineProperty(unmappable, "validation", {
    get(): never {
      throw new Error("the error handler itself failed");
    },
  });
  return unmappable;
}

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
  /** The reply of the last request to `/test/left-stream`. */
  let leftReply: FastifyReply | undefined;

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
        // `details` - the line about it obeys the rules of the request log.
        instance.get("/test/broken-with-details", async (_request, reply) => {
          reply.raw.emit(
            "error",
            new ValidationError("broken with details", {
              config: { url: LEAKED_URL },
            }),
          );
          return { ok: true };
        });
        // The head of an error response Node refuses to write: a header
        // value with a line break in it, set before the handler fails. Our
        // handler writes its line and its answer breaks on the head; Fastify's
        // default handler takes over and breaks on the same head; its own
        // fallback then writes the body without the headers of the reply.
        instance.get("/test/head-failed", async (_request, reply) => {
          reply.header("x-broken", `line${LINE_BREAK}break`);
          throw new AppError("UPSTREAM_FAILED", "provider failed", 502);
        });
        // The serializer of the error answer of Fastify's fallback throws: the
        // route declares a 500 body the error does not match, and our handler
        // fails before it answers, so the default handler and then the
        // fallback take the request.
        instance.get(
          "/test/serializer-failed",
          { schema: { response: { 500: z.object({ ok: z.literal(true) }) } } },
          async () => {
            throw unmappableError();
          },
        );
        // A stream body that fails after its first chunk went out with the
        // head: the failure is ours, and the head is already gone.
        instance.get("/test/failing-stream", async (_request, reply) => {
          const body = new Readable({ read() {} });
          body.push("first chunk");
          setTimeout(() => {
            body.destroy(
              new ValidationError("stream broke", {
                config: { url: LEAKED_URL },
              }),
            );
          }, 20);
          return reply.type("text/plain").send(body);
        });
        // A stream body the client stops reading half way: the first chunk
        // goes out with the head, the rest never comes.
        instance.get("/test/endless-stream", async (_request, reply) => {
          const body = new Readable({ read() {} });
          body.push("first chunk");
          return reply.type("text/plain").send(body);
        });
        // The same stream, its reply kept: the case emits an `error` on the
        // response once the client has left.
        instance.get("/test/left-stream", async (_request, reply) => {
          leftReply = reply;
          const body = new Readable({ read() {} });
          body.push("first chunk");
          return reply.type("text/plain").send(body);
        });
        // A stream body of ours cut short with the client still reading:
        // destroyed without an error, so Node reports the same premature
        // close as for a client that left - and the failure is ours.
        instance.get("/test/cut-stream", async (_request, reply) => {
          const body = new Readable({ read() {} });
          body.push("first chunk");
          setTimeout(() => {
            body.destroy();
          }, 20);
          return reply.type("text/plain").send(body);
        });
        // An error our own handler cannot map: reading it throws, so the
        // handler throws, and Fastify's default handler takes the request.
        instance.get("/test/unmappable", async () => {
          throw unmappableError();
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
        requestId,
      }),
    ]);
  });

  it("writes the error of a broken response the way the request log does", async () => {
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

  /** The lines of one request at `error`, in the order they were written. */
  function errorLines(entries: Record<string, unknown>[]): unknown[] {
    return entries.filter((e) => e.level === "error").map((e) => e.msg);
  }

  it("writes each failure of a response whose head broke, and no access line", async () => {
    recorder.clear();
    const res = await fetch(`${baseUrl()}/test/head-failed`, {
      headers: { authorization: AUTH_HEADER },
    });
    await res.text();
    const entries = recorder.entries();
    // The fallback writes the body without the headers of the reply, the id
    // header among them: the lines are tied together by the id they carry.
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeNull();
    const requestId = entries[0]?.requestId;
    expect(requestId).toEqual(expect.any(String));

    // Three failures of one request, one line each: ours, the default
    // handler's that took over when ours broke on the head, and the head
    // itself the fallback could not write (Т2 E0-12G, the named exception
    // to one line per request).
    expect(errorLines(entries)).toEqual([
      "request failed",
      "error handler failed",
      "response head failed",
    ]);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        routeUrl: "/test/head-failed",
        requestId,
      });
    }
    expect(entries[2]).toMatchObject({
      responseTime: expect.any(Number),
      err: expect.objectContaining({ code: "ERR_INVALID_CHAR" }),
    });
  });

  it("writes a serializer that threw on the error answer, and no access line", async () => {
    const { entries, requestId } = await writtenOverSocket(
      "/test/serializer-failed",
    );

    expect(errorLines(entries)).toEqual([
      "error handler failed",
      "response serializer failed",
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      method: "GET",
      routeUrl: "/test/serializer-failed",
      requestId,
      responseTime: expect.any(Number),
      // The failure of the serializer itself, not the error it was given.
      err: expect.objectContaining({
        type: "ResponseSerializationError",
        message: expect.stringContaining("Response doesn't match the schema"),
      }),
    });
  });

  it("writes a stream that failed after the head once, as an error", async () => {
    recorder.clear();
    const res = await fetch(`${baseUrl()}/test/failing-stream`, {
      headers: { authorization: AUTH_HEADER },
    });
    await res.text().catch(() => undefined);
    await waitForLine("response stream failed");
    const entries = recorder.entries();

    expect(entries.filter((e) => e.level === "error")).toEqual([
      expect.objectContaining({
        msg: "response stream failed",
        method: "GET",
        routeUrl: "/test/failing-stream",
        requestId: res.headers.get(REQUEST_ID_HEADER),
        err: expect.objectContaining({
          message: "stream broke",
          details: "[omitted]",
        }),
      }),
    ]);
    expect(recorder.raw()).not.toContain("super-secret-key");
  });

  it("writes a stream the client stopped reading as a short info line", async () => {
    recorder.clear();
    let requestId: unknown;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${baseUrl()}/test/endless-stream`,
        { headers: { authorization: AUTH_HEADER } },
        (res) => {
          requestId = res.headers[REQUEST_ID_HEADER];
          res.once("data", () => {
            req.destroy();
          });
        },
      );
      req.on("close", () => {
        resolve();
      });
      req.on("error", (err) => {
        if ("code" in err && err.code === "ECONNRESET") {
          return;
        }
        reject(err);
      });
      req.end();
    });
    await waitForLine("stream closed prematurely");
    // A request after it, to its access line: whatever the server was going
    // to write of the first one is written by then.
    const after = await fetch(`${baseUrl()}/health`);
    await after.text();
    await waitForLine("request completed");

    // The only line of the request: a response whose client left never
    // finishes, and Fastify never completes the request - no access line.
    expect(typeof requestId).toBe("string");
    const entries = recorder
      .entries()
      .filter((entry) => entry.requestId === requestId);
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "stream closed prematurely",
        method: "GET",
        routeUrl: "/test/endless-stream",
        status: 200,
        requestId,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("err");
  });

  it("writes no error line for a response that fails after its client left", async () => {
    recorder.clear();
    let requestId: unknown;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${baseUrl()}/test/left-stream`,
        { headers: { authorization: AUTH_HEADER } },
        (res) => {
          requestId = res.headers[REQUEST_ID_HEADER];
          res.once("data", () => {
            req.destroy();
          });
        },
      );
      req.on("close", () => {
        resolve();
      });
      req.on("error", (err) => {
        if ("code" in err && err.code === "ECONNRESET") {
          return;
        }
        reject(err);
      });
      req.end();
    });
    await waitForLine("stream closed prematurely");
    // The response of the request that has its line already fails as well:
    // Fastify reports it to the controller as a request completed with it.
    expect(leftReply).toBeDefined();
    leftReply?.raw.emit(
      "error",
      new Error("response failed after the client left"),
    );
    const after = await fetch(`${baseUrl()}/health`);
    await after.text();
    await waitForLine("request completed");

    expect(typeof requestId).toBe("string");
    expect(
      recorder.entries().filter((entry) => entry.requestId === requestId),
    ).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "stream closed prematurely",
      }),
    ]);
  });

  it("writes a stream of ours cut short with the client still there as an error", async () => {
    recorder.clear();
    const res = await fetch(`${baseUrl()}/test/cut-stream`, {
      headers: { authorization: AUTH_HEADER },
    });
    await res.text().catch(() => undefined);
    await waitForLine("response stream failed");

    expect(recorder.entries()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "response stream failed",
        routeUrl: "/test/cut-stream",
        requestId: res.headers.get(REQUEST_ID_HEADER),
        err: expect.objectContaining({ code: "ERR_STREAM_PREMATURE_CLOSE" }),
      }),
    ]);
  });

  /** Waits until a line with this message is written; fails if none comes. */
  async function waitForLine(msg: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (recorder.entries().some((e) => e.msg === msg)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `no "${msg}" line within 1 s; written: ${JSON.stringify(
        recorder.entries().map((e) => e.msg),
      )}`,
    );
  }

  it("writes a url the router refused as one short line and no access line", async () => {
    // The router builds this request on the server-wide context, without the
    // decorators: the type says the flags may be absent.
    expectTypeOf<FastifyRequest["failureLogged"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<FastifyRequest["authenticated"]>().toEqualTypeOf<
      boolean | undefined
    >();
    const { entries, requestId } = await written("/%");

    // Short and without the error: the flags of this request are absent,
    // and absent is not "gave the password".
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "request rejected",
        status: 400,
        requestId,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("err");
  });

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
