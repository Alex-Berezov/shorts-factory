import type { ApiClientOptions, FetchLike } from "@sf/api-client";
import { describe, expect, it, vi } from "vitest";

// The config the page reads at request time: the address of the API and the
// password, each a value no other field has, so a swap shows.
vi.mock("@sf/config/server", () => ({
  env: {
    API_INTERNAL_URL: "http://api.wiring.test:3001",
    ADMIN_PASSWORD: "wiring-password-0001",
  },
}));

const requests: { url: string; authorization: string | undefined }[] = [];

/** Records each call and answers like an API that is down. */
const recordingFetch: FetchLike = (input, init) => {
  const headers = new Headers(init.headers);
  requests.push({
    url: input,
    authorization: headers.get("authorization") ?? undefined,
  });
  return Promise.resolve(
    Response.json(
      { error: { code: "UNAVAILABLE", message: "down", requestId: "req-w" } },
      { status: 503, headers: { "x-request-id": "req-w" } },
    ),
  );
};

// The real client, without its `server-only` marker and with the network
// replaced, so the request it builds out of the config is what is checked.
vi.mock("@sf/api-client/server", async () => {
  const real = await import("@sf/api-client");
  return {
    ...real,
    createApiClient: (options: ApiClientOptions) =>
      real.createApiClient({ ...options, fetch: recordingFetch }),
  };
});

const { loadSystemStatus } = await import("@/lib/api.server");

describe("loadSystemStatus with the configured client", () => {
  it("calls the configured API with the configured password", async () => {
    await loadSystemStatus();

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("http://api.wiring.test:3001/system/status");
    const token = request?.authorization?.replace(/^Basic /, "") ?? "";
    expect(Buffer.from(token, "base64").toString("utf8")).toMatch(
      /:wiring-password-0001$/,
    );
  });
});
