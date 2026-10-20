import { Agent, type IncomingHttpHeaders, request } from "node:http";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import {
  type Recorder,
  recordingLogger,
} from "@sf/runtime/test-support/recording-logger";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_HEADER, buildTestApp, parseErrorBody } from "./helpers.js";

/**
 * The stop of the service as a caller sees it, over a real socket: Fastify
 * decides what a request routed during `close()` gets in `lib/route.js:480`,
 * a path `app.inject` never reaches once the instance is closing.
 */

interface Answer {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  reusedSocket: boolean;
}

/** One GET through the given agent, read to the end. */
function get(
  agent: Agent,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, agent, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            reusedSocket: req.reusedSocket,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) {
    await step();
  }
  cleanup = [];
});

/**
 * An app listening on a free port, whose `close()` stops inside `preClose`
 * until the test lets it go. The hook is added after `buildApp`'s own, so the
 * service is already closing when it runs, and `server.close()` - which comes
 * after the `preClose` hooks - has not been called: the window in which a
 * balancer still sends requests to an instance on its way out.
 */
async function closingApp(): Promise<{
  port: number;
  /** What the service wrote, from the start. */
  recorder: Recorder;
  /** Starts `close()` and settles once the service is closing. */
  startClose: () => Promise<void>;
}> {
  const recorder = recordingLogger();
  const app = buildTestApp({ logger: recorder.log });
  let entered = (): void => {};
  let release = (): void => {};
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.addHook("preClose", async () => {
    entered();
    await held;
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server is not listening on a tcp port");
  }

  let closed: Promise<void> | undefined;
  cleanup.push(async () => {
    release();
    await (closed ?? app.close());
  });

  return {
    port: address.port,
    recorder,
    startClose: async () => {
      closed = app.close();
      await closing;
    },
  };
}

describe("a request that arrives while the service is closing", () => {
  it("is answered 503 in the error envelope, on the same keep-alive socket", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanup.push(async () => agent.destroy());
    const stop = await closingApp();

    const first = await get(agent, stop.port, "/health");
    expect(first.statusCode).toBe(200);

    await stop.startClose();
    const second = await get(agent, stop.port, "/health");

    expect(second.reusedSocket).toBe(true);
    expect(second.statusCode).toBe(503);
    const body = parseErrorBody(second.body);
    expect(body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Service Unavailable",
    });
    expect(body.error.requestId).toBe(second.headers[REQUEST_ID_HEADER]);
    // Fastify's own, for every request routed while closing: the caller
    // should not send the next one down this socket.
    expect(second.headers.connection).toBe("close");
    // A verdict about this moment like every other answer of `/health`: a
    // cache that kept it would hold the next instance out of rotation.
    expect(second.headers["cache-control"]).toBe("no-store");
  });

  /**
   * Every request that reaches an instance on its way out gets this 503. It
   * is not a failure of the service: written at `error` with a stack, each
   * deploy would read as an incident in the log and in every alert on it.
   */
  it("is written as the short line of a refused request, not as a failure", async () => {
    const agent = new Agent({ keepAlive: false });
    cleanup.push(async () => agent.destroy());
    const stop = await closingApp();

    await stop.startClose();
    const answer = await get(agent, stop.port, "/health?probe=secret");
    const requestId = answer.headers[REQUEST_ID_HEADER];

    expect(answer.statusCode).toBe(503);
    const lines = stop.recorder
      .entries()
      .filter((entry) => entry.requestId === requestId);
    expect(lines).toEqual([
      {
        level: "info",
        time: expect.any(Number),
        pid: expect.any(Number),
        hostname: expect.any(String),
        status: 503,
        code: "INTERNAL_ERROR",
        method: "GET",
        requestId,
        routeUrl: "/health",
        msg: "request rejected",
      },
    ]);
    expect(stop.recorder.raw()).not.toContain("probe=secret");
  });

  it("is answered 503 before the password is asked for", async () => {
    // A stop is not a reason to tell a caller its credentials are wrong: a
    // 401 here would send an operator looking for a password problem.
    const agent = new Agent({ keepAlive: false });
    cleanup.push(async () => agent.destroy());
    const stop = await closingApp();

    await stop.startClose();
    const answer = await get(agent, stop.port, "/system/status");

    expect(answer.statusCode).toBe(503);
    expect(parseErrorBody(answer.body).error.code).toBe("INTERNAL_ERROR");
  });
});

describe("a request already in its handler when the service starts closing", () => {
  it("is let finish, and answered 200", async () => {
    let entered = (): void => {};
    let release = (): void => {};
    const inHandler = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = buildTestApp({
      routes: (instance) => {
        instance.get("/test/in-flight", async () => {
          entered();
          await held;
          return { finished: true };
        });
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server is not listening on a tcp port");
    }
    const agent = new Agent({ keepAlive: false });
    const stop: { closed?: Promise<void> } = {};
    cleanup.push(async () => {
      release();
      agent.destroy();
      await (stop.closed ?? app.close());
    });

    const answer = get(agent, address.port, "/test/in-flight", {
      authorization: AUTH_HEADER,
    });
    await inHandler;
    const closed = app.close();
    stop.closed = closed;
    let closedEarly = false;
    void closed.then(() => {
      closedEarly = true;
    });
    // The close waits for the request it found in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closedEarly).toBe(false);

    release();
    const finished = await answer;
    expect(finished.statusCode).toBe(200);
    expect(JSON.parse(finished.body)).toEqual({ finished: true });
    await closed;
  });
});
