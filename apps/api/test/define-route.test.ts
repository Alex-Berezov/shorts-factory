import { type ErrorBody, HealthResponseSchema } from "@sf/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppInstance } from "../src/app.js";
import {
  OK_STATUS,
  defineRoute,
  errorResponses,
} from "../src/lib/route-schemas.js";
import { AUTH_HEADER, buildTestApp } from "./helpers.js";

/**
 * `defineRoute` (`src/lib/route-schemas.ts`), the one way a module of
 * `src/routes` registers a route. What it promises at compile time is held by
 * `tsc` over this file (`pnpm typecheck`): each `@ts-expect-error` below names
 * a route that must not compile, and the directive itself turns red the day
 * that route compiles - when the reply type stops coming from the responses,
 * or when the schema takes its own `response` again. What it does at run time
 * is held by the cases.
 */

const responses = {
  ...errorResponses(),
  [OK_STATUS]: HealthResponseSchema,
};

const ENVELOPE: ErrorBody = {
  error: { code: "INTERNAL", message: "no", requestId: "r-1" },
};

/**
 * The routes the compiler checks. Registered by the first case below as well,
 * so the ones that compile are seen to work, and none of them is dead code.
 */
function compileTimeCases(app: AppInstance): void {
  defineRoute(
    app,
    {
      method: "GET",
      url: "/typed/:id",
      responses,
      schema: { params: z.object({ id: z.string() }) },
    },
    async (request) => {
      // `Params` from the zod schema through the type provider.
      const id: string = request.params.id;
      return { status: id === "" ? ("degraded" as const) : ("ok" as const) };
    },
  );

  defineRoute(
    app,
    { method: "GET", url: "/envelope", responses, schema: {} },
    // @ts-expect-error - the error envelope is a declared response, not the answer of the route: the reply type is `SuccessReply<typeof responses>`
    async () => ENVELOPE,
  );

  defineRoute(
    app,
    {
      method: "GET",
      url: "/second-response",
      responses,
      // @ts-expect-error - the responses of a route come in `responses` only, a second `schema.response` is refused
      schema: { response: { [OK_STATUS]: HealthResponseSchema } },
    },
    async () => ({ status: "ok" as const }),
  );

  defineRoute(
    app,
    {
      method: "GET",
      url: "/no-ok-status",
      // @ts-expect-error - the responses of a route have to declare `OK_STATUS`: the reply type is read off it
      responses: errorResponses(),
      schema: {},
    },
    async () => ({ status: "ok" as const }),
  );
}

/**
 * Routes that pass an option of the app - the ones the error envelope rests
 * on. Written in the definition, each does not compile (`@ts-expect-error`);
 * the last two get one past the type, through a spread and a cast. All of
 * them are thrown on at run time, before anything is registered.
 */
function appOptionCases(app: AppInstance): Array<() => void> {
  const own = { errorHandler: () => undefined };
  const base = {
    method: "GET" as const,
    url: "/through-cast",
    responses,
    schema: {},
  };
  return [
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/own-error-handler",
          responses,
          schema: {},
          // @ts-expect-error - the error handler is the app's: the envelope rests on it
          errorHandler: () => undefined,
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/own-serializer",
          responses,
          schema: {},
          // @ts-expect-error - the serializer compiler is the app's: the envelope rests on it
          serializerCompiler: () => () => "",
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/own-validator",
          responses,
          schema: {},
          // @ts-expect-error - the validator compiler is the app's
          validatorCompiler: () => () => ({ value: undefined }),
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/own-formatter",
          responses,
          schema: {},
          // @ts-expect-error - the schema error formatter is the app's
          schemaErrorFormatter: () => new Error("x"),
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/attach-validation",
          responses,
          schema: {},
          // @ts-expect-error - a route that keeps a validation failure for itself leaves the envelope
          attachValidation: true,
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        {
          method: "GET",
          url: "/through-spread",
          responses,
          schema: {},
          ...own,
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        app,
        Object.assign(base, { attachValidation: true }) as typeof base,
        async () => ({ status: "ok" as const }),
      ),
  ];
}

describe("defineRoute", () => {
  it("carries params of the schema to the registered route and validates them", async () => {
    const params = z.object({ id: z.string().min(3) });
    const seen: unknown[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          if (route.url === "/checked/:id" && route.method === "GET") {
            seen.push(route.schema?.params);
          }
        });
        root.register(async (child) => {
          defineRoute(
            child,
            {
              method: "GET",
              url: "/checked/:id",
              responses,
              schema: { params },
            },
            async () => ({ status: "ok" as const }),
          );
        });
      },
    });
    try {
      const headers = { authorization: AUTH_HEADER };
      const good = await app.inject({
        method: "GET",
        url: "/checked/abc",
        headers,
      });
      const bad = await app.inject({
        method: "GET",
        url: "/checked/a",
        headers,
      });
      expect(good.statusCode).toBe(OK_STATUS);
      expect(bad.statusCode).toBe(400);
      // The schema object itself, not one that merely looks like it.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(params);
    } finally {
      await app.close();
    }
  });

  it("registers the routes whose types are checked, and the typed one answers", async () => {
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          compileTimeCases(child);
        });
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/typed/abc",
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("registers the route with its responses as schema.response and its options", async () => {
    const seen: unknown[] = [];
    const schemas: unknown[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          if (route.url === "/defined" && route.method === "GET") {
            seen.push(route.schema?.response);
            schemas.push(route.schema);
          }
        });
        root.register(async (child) => {
          defineRoute(
            child,
            {
              method: "GET",
              url: "/defined",
              responses,
              schema: { summary: "a route", tags: ["test"] },
              onSend: (_request, reply, payload, done) => {
                reply.header("x-defined", "yes");
                done(null, payload);
              },
            },
            async () => ({ status: "ok" as const }),
          );
        });
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/defined",
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toEqual({ status: "ok" });
      expect(response.headers["x-defined"]).toBe("yes");
      expect(seen).toEqual([responses]);
      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toMatchObject({
        summary: "a route",
        tags: ["test"],
        response: responses,
      });
    } finally {
      await app.close();
    }
  });

  it("throws on an option of the app however it comes in, and registers nothing", async () => {
    const thrown: string[] = [];
    const registered: string[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          registered.push(route.url);
        });
        root.register(async (child) => {
          for (const register of appOptionCases(child)) {
            try {
              register();
            } catch (error) {
              thrown.push(error instanceof Error ? error.message : "");
            }
          }
        });
      },
    });
    try {
      await app.ready();
      const cases = [
        ["/own-error-handler", "errorHandler"],
        ["/own-serializer", "serializerCompiler"],
        ["/own-validator", "validatorCompiler"],
        ["/own-formatter", "schemaErrorFormatter"],
        ["/attach-validation", "attachValidation"],
        ["/through-spread", "errorHandler"],
        ["/through-cast", "attachValidation"],
      ];
      expect(thrown).toEqual(
        cases.map(
          ([url, key]) =>
            `route GET ${url}: options of the app in a route (${key}) - the error envelope rests on them`,
        ),
      );
      const urls = cases.map(([url]) => url);
      expect(registered.filter((url) => urls.includes(url))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
