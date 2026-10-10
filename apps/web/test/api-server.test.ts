import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiClient } from "@sf/api-client";
import { ApiContractError, ApiError, createApiClient } from "@sf/api-client";
import type { SystemStatusResponse } from "@sf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

// The config parses `.env` when it is evaluated; here it throws instead, which
// is what `next build` meets on a machine without one. Importing the module
// under test must not evaluate it.
vi.mock("@sf/config/server", () => {
  throw new Error("@sf/config/server evaluated at import time");
});

// The real client without its `server-only` marker, which throws outside the
// `react-server` condition Next resolves it under. Same classes, so the
// `instanceof` checks below see the errors the client really throws.
vi.mock("@sf/api-client/server", async () => await import("@sf/api-client"));

// The import is the check that the config stays lazy: evaluating it here
// throws, and the whole file fails before any case runs.
const { loadSystemStatus } = await import("@/lib/api.server");

const STATUS: SystemStatusResponse = {
  build: { version: null, commit: null },
  uptimeSec: 12,
  checks: {
    db: { status: "up", reason: null },
    redis: { status: "down", reason: "timeout" },
  },
  queues: null,
  dlq: { size: 0 },
  worker: { heartbeatAt: null, stale: true },
  budget: null,
};

/** A client whose `systemStatus` does what the test says. */
function clientWith(systemStatus: ApiClient["systemStatus"]) {
  const client: ApiClient = {
    health: () => Promise.reject(new Error("not used")),
    systemStatus,
  };
  return () => Promise.resolve(client);
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("api.server", () => {
  it("returns the status the API answered", async () => {
    const result = await loadSystemStatus(
      clientWith(() => Promise.resolve(STATUS)),
    );
    expect(result).toEqual({ kind: "ok", data: STATUS });
  });

  it("turns an error envelope into api-failed with its code", async () => {
    const result = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiError({
            status: 500,
            code: "INTERNAL",
            message: "connect ECONNREFUSED 10.0.0.5:5432",
            requestId: "req-1",
          }),
        ),
      ),
    );
    expect(result).toEqual({
      kind: "api-failed",
      status: 500,
      code: "INTERNAL",
      requestId: "req-1",
    });
  });

  it("turns a call that got no response into unreachable", async () => {
    const result = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiContractError("GET /system/status did not reach the API", {
            cause: new TypeError("fetch failed"),
          }),
        ),
      ),
    );
    expect(result).toEqual({ kind: "unreachable" });
  });

  it("turns a body that stopped coming until the timeout into unreachable", async () => {
    // A real server and the real client: headers of a 200, the first byte of
    // the body, then nothing. The fetch rejects the read with the reason of
    // its timeout signal.
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "req-slow",
      });
      response.write("{");
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const client = createApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      password: "test-admin-password",
      timeoutMs: 100,
    });

    const result = await loadSystemStatus(() => Promise.resolve(client));
    expect(result).toEqual({ kind: "unreachable" });
  });

  it("takes a body read aborted by the timeout signal for unreachable too", async () => {
    // Runtimes that report the abort rather than its reason reject the read
    // with an `AbortError` instead of a `TimeoutError`.
    const result = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiContractError(
            "GET /system/status answered an unreadable body",
            {
              status: 200,
              requestId: "req-5",
              cause: new DOMException(
                "This operation was aborted",
                "AbortError",
              ),
            },
          ),
        ),
      ),
    );
    expect(result).toEqual({ kind: "unreachable" });
  });

  it("keeps an unreadable body that did not time out a contract failure", async () => {
    const result = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiContractError(
            "GET /system/status answered an unreadable body",
            {
              status: 200,
              requestId: "req-4",
              cause: new TypeError("terminated"),
            },
          ),
        ),
      ),
    );
    expect(result).toEqual({ kind: "contract", requestId: "req-4" });
  });

  it("turns an answer off the contract into contract, with its id", async () => {
    const withId = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiContractError("GET /system/status answered 502, not JSON", {
            status: 502,
            requestId: "req-2",
          }),
        ),
      ),
    );
    expect(withId).toEqual({ kind: "contract", requestId: "req-2" });

    const withoutId = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiContractError("GET /system/status answered 200, drift", {
            status: 200,
          }),
        ),
      ),
    );
    expect(withoutId).toEqual({ kind: "contract" });
  });

  it("rethrows anything else for error.tsx", async () => {
    const defect = new TypeError("cannot read properties of undefined");
    await expect(
      loadSystemStatus(clientWith(() => Promise.reject(defect))),
    ).rejects.toBe(defect);
  });

  it("keeps the message of a failure out of the result", async () => {
    const result = await loadSystemStatus(
      clientWith(() =>
        Promise.reject(
          new ApiError({
            status: 500,
            code: "INTERNAL",
            message: "http://admin:pw@api:3001 refused",
            requestId: "req-3",
          }),
        ),
      ),
    );
    expect(JSON.stringify(result)).not.toContain("api:3001");
    expect(JSON.stringify(result)).not.toContain("pw");
  });
});
