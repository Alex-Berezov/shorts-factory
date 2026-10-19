import type {
  FastifyHttpOptions,
  RawServerDefault,
  RouteOptions,
} from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppInstance } from "../src/app.js";
import { DOCS_ROUTE, OPENAPI_ROUTE } from "../src/plugins/openapi.js";
import {
  AUTH_HEADER,
  TEST_PASSWORD,
  basicAuthHeader,
  buildTestApp,
  parseErrorBody,
} from "./helpers.js";

/**
 * Every route an app of this file registers, from its first one: the hook is
 * added where the instance is created, before `buildApp` registers anything.
 * The documentation routes are registered synchronously inside `buildApp`, so
 * a hook added to the app `buildTestApp()` returns would never see them.
 */
const registered = vi.hoisted(() => ({ routes: new Array<RouteOptions>() }));

vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  const recording = ((options?: FastifyHttpOptions<RawServerDefault>) => {
    const app = actual.default(options);
    app.addHook("onRoute", (route) => {
      registered.routes.push(route);
    });
    return app;
  }) as typeof actual.default;
  return { ...actual, default: recording };
});

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
    const docs = await app.inject({ method: "GET", url: DOCS_ROUTE });
    const document = await app.inject({ method: "GET", url: OPENAPI_ROUTE });

    expect(docs.statusCode).toBe(401);
    expect(document.statusCode).toBe(401);
  });

  it("serves the documentation with the password", async () => {
    const document = await app.inject({
      method: "GET",
      url: OPENAPI_ROUTE,
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

/** The methods `app.inject` sends. */
const INJECTABLE_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

function isInjectable(
  method: string,
): method is (typeof INJECTABLE_METHODS)[number] {
  const methods: readonly string[] = INJECTABLE_METHODS;
  return methods.includes(method);
}

/**
 * The password over every route of the assembled app, the documentation
 * included: a route that fell out of the global hook of `plugins/auth.ts`
 * answers without credentials, and the shape of its schema says nothing
 * about that.
 */
describe("the password over the routes of the app", () => {
  it("is asked for on every route but the public ones", async () => {
    registered.routes.length = 0;
    const app = buildTestApp();
    await app.ready();
    const routes = registered.routes.splice(0);
    try {
      const answered: { route: string; status: number }[] = [];
      for (const route of routes) {
        // A parameter or a wildcard of the route stands for any value.
        const url = route.url.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
        for (const method of [route.method].flat()) {
          // A method `inject` cannot send is a route this sweep cannot
          // vouch for: it stands as answered with nothing, which fails.
          const status = isInjectable(method)
            ? (await app.inject({ method, url })).statusCode
            : 0;
          answered.push({ route: `${method} ${route.url}`, status });
        }
      }

      expect(answered.length).toBeGreaterThan(4);
      // The routes an anonymous caller is answered on, spelled out: the
      // public list of `plugins/auth.ts` (`PUBLIC_ROUTES`) and the HEAD twin
      // of its GET - a route added to it is a change of this list too.
      expect(
        answered
          .filter(({ status }) => status !== 401)
          .map(({ route }) => route)
          .sort(),
      ).toEqual(["GET /health", "HEAD /health"]);
    } finally {
      await app.close();
    }
  });
});
