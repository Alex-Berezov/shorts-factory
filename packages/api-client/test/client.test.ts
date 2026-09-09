import { REQUEST_ID_HEADER } from "@sf/contracts";
import { type Mock, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/index.js";
import { ApiContractError, ApiError, createApiClient } from "../src/index.js";

const BASE_URL = "http://api.internal:3001";
const PASSWORD = "test-admin-password";
/** What the API expects in `Authorization`, spelled out rather than rebuilt. */
const EXPECTED_AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

const HEALTHY = { status: "ok" };
const DEGRADED = { status: "degraded" };
const SYSTEM_STATUS = {
  build: { version: "1.2.3", commit: "abc1234" },
  uptimeSec: 42,
  checks: { db: "up", redis: "down" },
};

/**
 * A client whose transport answers with the given response, built from a real
 * `Response`: a stub object with a `json()` on it would be accepted whatever
 * the status code was, and the branch this file is mostly about is the one
 * that reads `ok` and `status`.
 */
function clientAnswering(
  body: string,
  init: ResponseInit = {},
  baseUrl: string = BASE_URL,
): { client: ApiClient; transport: Mock } {
  const transport = vi.fn(async () => new Response(body, init));
  return {
    client: createApiClient({ baseUrl, password: PASSWORD, fetch: transport }),
    transport,
  };
}

/**
 * A body handed over one chunk at a time, counting the chunks that were asked
 * for and whether the rest was let go of.
 *
 * A string body would say nothing about the bound this file is checking: by
 * the time `await response.text()` returns, everything the other side sent is
 * already in memory, so a check on the result is a check made too late. A
 * stream is where the difference shows - in how much of it was pulled.
 *
 * The first chunk is pulled by the stream itself, before anything reads it
 * (the queue holds one chunk), so a count of one means nothing was read.
 */
function chunkedBody(
  chunkBytes: number,
  chunks: number,
): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulls = 0;
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunks) {
        controller.close();
        return;
      }
      pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      stopped = true;
    },
  });
  return { stream, pulled: () => pulls, cancelled: () => stopped };
}

/** The response of a route that answered as the contract says it would. */
function json(payload: unknown, status = 200): [string, ResponseInit] {
  return [
    JSON.stringify(payload),
    { status, headers: { "content-type": "application/json" } },
  ];
}

/** The error envelope of this API, as the error handler builds it. */
function envelope(
  code: string,
  details?: unknown,
): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = {
    code,
    message: "something went wrong",
    requestId: "req-77",
  };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

describe("createApiClient", () => {
  it("returns the parsed body of /health", async () => {
    const { client } = clientAnswering(...json(HEALTHY));

    await expect(client.health()).resolves.toEqual({ status: "ok" });
  });

  it("asks the health route once, and without credentials", async () => {
    // The public route does not check the password, and a password sent where
    // nothing verifies it is a password in one more access log.
    const { client, transport } = clientAnswering(...json(HEALTHY));

    await client.health();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(`${BASE_URL}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("sends credentials built from the password to the closed route", async () => {
    const { client, transport } = clientAnswering(...json(SYSTEM_STATUS));

    await client.systemStatus();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(`${BASE_URL}/system/status`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: EXPECTED_AUTH,
      },
      // A 3xx would carry the password to wherever it points; a moved route
      // is a failure to see, not one to follow.
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("joins a base url that ends in a slash without doubling it", async () => {
    const { client, transport } = clientAnswering(
      ...json(HEALTHY),
      `${BASE_URL}/`,
    );

    await client.health();

    expect(transport).toHaveBeenCalledWith(
      `${BASE_URL}/health`,
      expect.anything(),
    );
  });

  it("returns the parsed body of /system/status", async () => {
    const { client, transport } = clientAnswering(...json(SYSTEM_STATUS));

    await expect(client.systemStatus()).resolves.toEqual(SYSTEM_STATUS);
    expect(transport).toHaveBeenCalledWith(
      `${BASE_URL}/system/status`,
      expect.anything(),
    );
  });

  it("hands the caller only the fields the contract describes", async () => {
    // An API that starts sending a field this client has never heard of does
    // not break it - but the value is not passed on either, because nothing
    // validated it.
    const { client } = clientAnswering(
      ...json({ status: "ok", queueDepth: 12 }),
    );

    await expect(client.health()).resolves.toEqual({ status: "ok" });
  });

  it("reads a degraded health answer as an answer, not as a failure", async () => {
    // The route declares 503 as its own: Postgres is down, the service says
    // so, and the status code is what a container healthcheck reads. A client
    // that treated every non-2xx as an error envelope would make the one
    // answer an operator needs during an incident unreachable - and would
    // leave the `degraded` branch of `HealthResponse` unreachable with it.
    const { client } = clientAnswering(...json(DEGRADED, 503));

    await expect(client.health()).resolves.toEqual({ status: "degraded" });
  });

  it("still reads a failure on the health route as a failure", async () => {
    // The same status carries both shapes: a probe that threw leaves through
    // the error handler with 503 and the envelope in the body.
    const { client } = clientAnswering(
      ...json(envelope("DB_UNAVAILABLE"), 503),
    );

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: "DB_UNAVAILABLE" });
  });

  it.each([
    ["a missing field", {}],
    ["a value outside the contract", { status: "fine" }],
    ["a field of the wrong type", { status: 1 }],
    ["a body that is not an object", "ok"],
  ])("refuses an answer with %s", async (_name, payload) => {
    // This is the drift the client exists to catch: without the parse the
    // caller would read `undefined` out of a field it was promised.
    const { client } = clientAnswering(...json(payload));

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("refuses a body that is not JSON at all", async () => {
    const { client } = clientAnswering("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiContractError);
    expect(failure).not.toBeInstanceOf(ApiError);
    expect((failure as ApiContractError).status).toBe(502);
  });

  it("refuses an empty body instead of resolving with nothing", async () => {
    const { client } = clientAnswering("", { status: 200 });

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("keeps the correlation id of an answer that had no envelope", async () => {
    // The failure hardest to look into is the one with no body to read a
    // `requestId` out of; the header carries the id the API already wrote its
    // log line under.
    const { client } = clientAnswering("<html>502</html>", {
      status: 502,
      headers: { [REQUEST_ID_HEADER]: "req-42" },
    });

    const failure = await client.health().catch((err: unknown) => err);

    expect((failure as ApiContractError).requestId).toBe("req-42");
  });

  it("refuses an answer that announces more than it may read", async () => {
    // Not this API: its answers are a status report or an envelope, both well
    // under a kilobyte. A body of this size is read to the end on every
    // server render otherwise.
    const { client } = clientAnswering(JSON.stringify(HEALTHY), {
      status: 200,
      headers: { "content-length": String(1024 * 1024) },
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("refuses an answer whose body is past the size limit", async () => {
    // Valid JSON of the right shape, and a megabyte of padding around it: a
    // client that only reads the announced length believes whatever the other
    // side announced.
    const { client } = clientAnswering(
      ...json({ status: "ok", pad: "x".repeat(1024 * 1024) }),
    );

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("stops reading a body at the limit instead of holding all of it", async () => {
    // The answer of this API is a status report or an envelope, both under a
    // kilobyte. A hop that streams 16 MiB and declares no size is read to the
    // end otherwise - a check on the announced length has nothing to look at -
    // and a server render of `/system` grows by whatever was sent.
    const body = chunkedBody(64 * 1024, 256);
    const transport = vi.fn(async () => new Response(body.stream));
    const client = createApiClient({
      baseUrl: BASE_URL,
      password: PASSWORD,
      fetch: transport,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
    // 64 KiB per chunk against a 64 KiB limit: reading stops on the chunk
    // that crosses it, so a handful of chunks and not all 256.
    expect(body.pulled()).toBeLessThanOrEqual(4);
    expect(body.cancelled()).toBe(true);
  });

  it("lets go of a body it refuses by its announced size", async () => {
    // Nothing is read, and the connection is not left to the garbage
    // collector: a server render with a broken upstream would otherwise hold
    // a socket per request until then.
    const body = chunkedBody(1024, 1024);
    const transport = vi.fn(
      async () =>
        new Response(body.stream, {
          headers: { "content-length": String(1024 * 1024) },
        }),
    );
    const client = createApiClient({
      baseUrl: BASE_URL,
      password: PASSWORD,
      fetch: transport,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiContractError);
    expect(body.pulled()).toBeLessThanOrEqual(1);
    expect(body.cancelled()).toBe(true);
  });

  it("refuses an answer whose body belongs to another status", async () => {
    // `{"status":"ok"}` with a 503 is not this API: the route sends the word
    // and the code together (`HEALTH_STATUS_CODES`). Read as an answer, it
    // puts "ok" on the card of an operator looking at an outage.
    const { client } = clientAnswering(...json(HEALTHY, 503));

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiContractError);
    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it.each([
    ["longer than an id gets", "x".repeat(200)],
    ["that is not one token", "req 42 and whatever else"],
  ])("drops a correlation id %s", async (_name, value) => {
    // The header is whatever the last hop set. An unbounded one travels into
    // a log line of web and into an error page as if the API had written it.
    const { client } = clientAnswering("<html>502</html>", {
      status: 502,
      headers: { [REQUEST_ID_HEADER]: value },
    });

    const failure = await client.health().catch((err: unknown) => err);

    expect((failure as ApiContractError).requestId).toBeUndefined();
  });

  it("gives up on a transport that never answers", async () => {
    // A hung API must not hold the page that exists to report the outage.
    const transport = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const client = createApiClient({
      baseUrl: BASE_URL,
      password: PASSWORD,
      fetch: transport,
      timeoutMs: 20,
    });

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiContractError);
    expect(transport.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a failure the API described as an ApiError", async () => {
    const { client } = clientAnswering(...json(envelope("UNAUTHORIZED"), 401));

    const failure = await client.systemStatus().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      requestId: "req-77",
      message: "something went wrong",
    });
    // Absent in the envelope, absent on the error: the field is not invented
    // as `undefined` for every caller to check.
    expect("details" in (failure as ApiError)).toBe(false);
  });

  it("keeps the details of a failure that carried some", async () => {
    const spent = { provider: "gemini", spent: 5.25, cap: 5 };
    const { client } = clientAnswering(
      ...json(envelope("BUDGET_EXCEEDED", spent), 429),
    );

    const failure = await client.systemStatus().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).details).toEqual(spent);
  });

  it("reports a 500 the same way, by its code", async () => {
    const { client } = clientAnswering(
      ...json(envelope("INTERNAL_ERROR"), 500),
    );

    await expect(client.health()).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("does not dress a failure outside the envelope as an ApiError", async () => {
    // A proxy, a load balancer or a route of some other service can answer
    // with valid JSON; a `code` read out of it would be one the API never sent.
    const { client } = clientAnswering(...json({ message: "nope" }, 503));

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiContractError);
    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it("calls the fetch of the runtime, at the moment of the call", async () => {
    // The default transport is read when the request is made and called on
    // `globalThis`: a reference taken at construction misses a runtime that
    // installs its own `fetch` later, and a detached one throws
    // `Illegal invocation` where `fetch` is bound to its global object.
    const client = createApiClient({
      baseUrl: BASE_URL,
      password: PASSWORD,
      timeoutMs: 200,
    });
    const installed = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(...json(HEALTHY)));

    try {
      await expect(client.health()).resolves.toEqual({ status: "ok" });
      expect(installed).toHaveBeenCalledTimes(1);
    } finally {
      installed.mockRestore();
    }
  });

  it("reports a transport that never answered", async () => {
    const cause = new Error("ECONNREFUSED");
    const transport = vi.fn(async () => {
      throw cause;
    });
    const client = createApiClient({
      baseUrl: BASE_URL,
      password: PASSWORD,
      fetch: transport,
    });

    const failure = await client.health().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiContractError);
    expect((failure as ApiContractError).status).toBeUndefined();
    expect((failure as ApiContractError).cause).toBe(cause);
  });

  it("keeps the base url out of the message it throws", async () => {
    // `API_INTERNAL_URL` can carry credentials of its own, and this message
    // travels into a log line and into an error page.
    const secretBase = "http://admin:hunter2@api.internal:3001";
    const { client } = clientAnswering(...json({}, 200), secretBase);

    const failure = await client.health().catch((err: unknown) => err);

    expect((failure as Error).message).not.toContain("hunter2");
    expect((failure as Error).message).toContain("/health");
  });
});
