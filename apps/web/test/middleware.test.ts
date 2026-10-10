import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sf/config/server", () => ({
  env: { ADMIN_PASSWORD: "test-admin-password" },
}));

const { config, middleware } = await import("@/middleware");

function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new NextRequest("http://localhost:3000/system", { headers });
}

function basic(credentials: string): string {
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

describe("middleware", () => {
  it("asks for the password when there is no header", () => {
    const response = middleware(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("refuses a wrong password", () => {
    const response = middleware(request(basic("admin:wrong-password")));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("refuses a header that is not basic auth", () => {
    const response = middleware(request("Bearer test-admin-password"));
    expect(response.status).toBe(401);
  });

  it("lets the right password through under any user name", () => {
    for (const user of ["admin", "operator", ""]) {
      const response = middleware(
        request(basic(`${user}:test-admin-password`)),
      );
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("keeps both the page and the refusal out of shared caches", () => {
    const passed = middleware(request(basic("admin:test-admin-password")));
    const refused = middleware(request(basic("admin:wrong-password")));
    for (const response of [passed, refused]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(passed.headers.get("x-middleware-next")).toBe("1");
    expect(refused.status).toBe(401);
    // Only the refusal promises a Vary: on a page that passed, Next sends
    // its own instead, and a test of a header that never leaves would lie.
    expect(refused.headers.get("vary")).toBe("Authorization");
    expect(passed.headers.get("vary")).toBeNull();
  });

  it("runs in the Node runtime", () => {
    expect(config.runtime).toBe("nodejs");
  });
});

describe("middleware matcher", () => {
  const matches = (path: string): boolean =>
    unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` });

  it.each([
    "/",
    "/system",
    "/radar",
    "/_next/data/build-id/system.json",
    "/api/anything",
    "/_next/static",
    "/_next/staticx",
    "/_next/staticx/chunks/x.js",
    "/_next/imagex",
    "/favicon.ico.bak",
  ])("guards %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/x.js",
    "/_next/static/css/app.css",
    "/_next/image",
    "/favicon.ico",
  ])("leaves %s to the browser without a prompt", (path) => {
    expect(matches(path)).toBe(false);
  });
});
