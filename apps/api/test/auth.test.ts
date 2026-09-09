import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../src/app.js";
import {
  AUTH_HEADER,
  TEST_PASSWORD,
  basicAuthHeader,
  buildTestApp,
  parseErrorBody,
} from "./helpers.js";

/**
 * The API carries one secret and is not published outside the internal
 * network (decision 2 of the epic), so the interesting cases are all about
 * what is *not* behind the password: `/health` on purpose, and nothing else
 * by accident.
 */
describe("basic auth", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a request without credentials and asks for them", async () => {
    const res = await app.inject({ method: "GET", url: "/system/status" });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('realm="shorts-factory"');
    // The rejection is shaped like every other error of this API, not like a
    // plugin's own payload.
    expect(parseErrorBody(res.payload).error).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a wrong password", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/system/status",
      headers: { authorization: basicAuthHeader("not-the-password") },
    });

    expect(res.statusCode).toBe(401);
  });

  it("accepts the right password under any user name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/system/status",
      headers: {
        authorization: basicAuthHeader(TEST_PASSWORD, "someone-else"),
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("leaves /health open", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
  });

  it("leaves /health open with a query string", async () => {
    // The public list is matched against the declared route url; matching the
    // requested url would either close this or open anything that starts with
    // the same characters.
    const res = await app.inject({ method: "GET", url: "/health?probe=1" });

    expect(res.statusCode).toBe(200);
  });

  it.each(["/health/", "//health"])(
    "leaves %s open, the way a healthcheck or a proxy writes it",
    async (url) => {
      // A container healthcheck and a proxy that normalises paths write the
      // liveness url with a trailing or a doubled slash; without the routing
      // options of `buildApp` those are unknown paths, and an unknown path is
      // a 401 - with both dependencies up.
      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(200);
    },
  );

  it.each(["/system/status/", "//system/status"])(
    "keeps %s behind the password",
    async (url) => {
      // The same normalisation must not open anything else.
      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(401);
    },
  );

  it("keeps the documentation behind the password", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs" });
    const document = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(docs.statusCode).toBe(401);
    expect(document.statusCode).toBe(401);
  });

  it("serves the documentation with the password", async () => {
    const document = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { authorization: AUTH_HEADER },
    });

    expect(document.statusCode).toBe(200);
  });

  it("asks for credentials on an unknown path too", async () => {
    // An unauthenticated 404 would tell an outsider which paths exist.
    const res = await app.inject({ method: "GET", url: "/no-such-route" });

    expect(res.statusCode).toBe(401);
  });
});
