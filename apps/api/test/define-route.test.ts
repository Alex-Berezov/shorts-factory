import {
  type ErrorBody,
  HealthResponseSchema,
  REQUEST_ID_HEADER,
} from "@sf/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OK_STATUS,
  type RouteRegistrar,
  defineRoute,
  errorResponses,
  isDefinedRoute,
  routeRegistrar,
} from "../src/lib/define-route.js";
import { AUTH_HEADER, buildTestApp } from "./helpers.js";

/**
 * `defineRoute` (`src/lib/define-route.ts`), the one way a module of
 * `src/routes` registers a route, and `RouteRegistrar`, the only thing such a
 * module gets to register it with. What they promise at compile time is held
 * by `tsc` over this file (`pnpm typecheck`): each `@ts-expect-error` below
 * names a route that must not compile, and the directive itself turns red the
 * day that route compiles - when the reply type stops coming from the
 * responses, when the schema takes its own `response` again, or when the
 * registrar lets a module reach the instance. What they do at run time is
 * held by the cases.
 */

const responses = {
  ...errorResponses(),
  [OK_STATUS]: HealthResponseSchema,
};

const ENVELOPE: ErrorBody = {
  error: { code: "INTERNAL", message: "no", requestId: "r-1" },
};

const handler = async (): Promise<{ status: "ok" }> => ({ status: "ok" });

/**
 * The routes the compiler checks. Registered by the second case below as
 * well, so the ones that compile are seen to work, and none of them is dead
 * code.
 */
function compileTimeCases(registrar: RouteRegistrar): void {
  defineRoute(
    registrar,
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

  // Calls named like the methods of the instance, on things that are not
  // one: they compile next to `defineRoute` with no directive (the line rule
  // that held the shape before the registrar refused them).
  const repo = new Map<string, "ok" | "degraded">([["a", "ok"]]);
  defineRoute(
    registrar,
    {
      method: "GET",
      url: "/neighbours",
      responses,
      schema: { querystring: z.object({ id: z.string() }) },
    },
    async (request) => {
      const searchParams = new URLSearchParams(request.query.id);
      const map = new Map(repo);
      map.delete(searchParams.get("drop") ?? "");
      return { status: map.get(request.query.id) ?? ("degraded" as const) };
    },
  );

  defineRoute(
    registrar,
    { method: "GET", url: "/envelope", responses, schema: {} },
    // @ts-expect-error - the error envelope is a declared response, not the answer of the route: the reply type is `SuccessReply<typeof responses>`
    async () => ENVELOPE,
  );

  defineRoute(
    registrar,
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
    registrar,
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
 * on - or a hook that may rewrite the body. Written in the definition, each
 * does not compile (`@ts-expect-error`); the spreads and the cast get one
 * past the type. All of them are thrown on at run time, before anything is
 * registered.
 */
function appOptionCases(registrar: RouteRegistrar): Array<() => void> {
  const own = { errorHandler: () => undefined };
  // Hooks of the shape Fastify takes: the spread gets them past the type, not
  // a signature the type would refuse anyway.
  const passBody = (
    _request: unknown,
    _reply: unknown,
    payload: unknown,
    done: (error: null, payload: unknown) => void,
  ): void => done(null, payload);
  const sending = { onSend: passBody };
  const serializing = { preSerialization: passBody };
  const base = {
    method: "GET" as const,
    url: "/through-cast",
    responses,
    schema: {},
  };
  return [
    () =>
      defineRoute(
        registrar,
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
        registrar,
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
        registrar,
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
        registrar,
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
        registrar,
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
        registrar,
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
        registrar,
        Object.assign(base, { attachValidation: true }) as typeof base,
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/own-on-send",
          responses,
          schema: {},
          // @ts-expect-error - a hook that gets the serialized body may hand back another: headers go in `replyHeaders`
          onSend: (_request, _reply, payload, done) => done(null, payload),
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/own-pre-serialization",
          responses,
          schema: {},
          // @ts-expect-error - a hook that may replace the body before it is serialized is not the route's
          preSerialization: (_request, _reply, payload, done) =>
            done(null, payload),
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/on-send-through-spread",
          responses,
          schema: {},
          ...sending,
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/pre-serialization-through-spread",
          responses,
          schema: {},
          ...serializing,
        },
        async () => ({ status: "ok" as const }),
      ),
  ];
}

/**
 * Routes with a header in `replyHeaders` that a route does not set, by name
 * or by value: one written in the definition does not compile, and
 * `Object.assign` gets the others past the type - a header of the body, of
 * the app, the allowed one written with a capital, and the allowed name with
 * a value outside its list: a line break, `undefined`, a value that would
 * put the answer into a shared cache, an empty one. Each is thrown on before
 * anything is registered.
 */
function replyHeaderCases(registrar: RouteRegistrar): Array<() => void> {
  const register =
    (url: string, replyHeaders: Readonly<Record<string, string | undefined>>) =>
    () => {
      const definition = { method: "GET" as const, url, responses, schema: {} };
      // The headers ride on the definition at run time; its type is the one
      // without them.
      const passed: typeof definition = Object.assign(definition, {
        replyHeaders,
      });
      defineRoute(registrar, passed, async () => ({ status: "ok" as const }));
    };
  return [
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/own-content-length",
          responses,
          schema: {},
          // @ts-expect-error - the length describes the body the serializer wrote: not a header of the route
          replyHeaders: { "content-length": "5" },
        },
        async () => ({ status: "ok" as const }),
      ),
    () =>
      defineRoute(
        registrar,
        {
          method: "GET",
          url: "/own-public-cache",
          responses,
          schema: {},
          // @ts-expect-error - an answer behind basic auth does not go into a shared cache: `no-store` is the one value
          replyHeaders: { "cache-control": "public, max-age=86400" },
        },
        async () => ({ status: "ok" as const }),
      ),
    register("/content-length-past-type", { "content-length": "5" }),
    register("/content-type-past-type", { "content-type": "text/plain" }),
    register("/set-cookie-past-type", { "set-cookie": "a=1" }),
    register("/request-id-past-type", { [REQUEST_ID_HEADER]: "forged" }),
    register("/capital-past-type", { "Cache-Control": "no-store" }),
    register("/line-break-past-type", { "cache-control": "no-store\r\nx: y" }),
    register("/undefined-past-type", { "cache-control": undefined }),
    register("/public-past-type", { "cache-control": "public, max-age=86400" }),
    register("/empty-past-type", { "cache-control": "" }),
    // A value `String()` cannot turn into text: the message names its type.
    register("/null-prototype-past-type", {
      "set-cookie": Object.create(null),
    }),
  ];
}

/** A registration that names its receiver `this`. */
function registerThroughThis(this: RouteRegistrar): void {
  // @ts-expect-error - the registrar has no `delete`, whatever the receiver is called
  this.delete("/through-this", handler);
}

/**
 * Every way past `defineRoute` that the line rule S13 used to refuse, and
 * the ones it could not see: none compiles on a registrar, and each throws at
 * run time - the registrar has no method of the instance to call. Each case
 * carries the name of the method it reaches for: run on `bait` below, which
 * has every method, it has to reach that one and no other, so a case that
 * fails for a reason of its own (a typo, a wrong argument) does not pass for
 * one that reached for the instance - and no text of the engine's
 * `TypeError` is relied on.
 */
function registrarBypassCases(
  registrar: RouteRegistrar,
): Array<readonly [method: string, run: () => unknown]> {
  return [
    [
      "get",
      // @ts-expect-error - no `get` on the registrar: a route goes through `defineRoute`
      () => registrar.get("/x", handler),
    ],
    [
      "post",
      // @ts-expect-error - no `post` on the registrar
      () => registrar.post("/x", handler),
    ],
    [
      "put",
      // @ts-expect-error - no `put` on the registrar
      () => registrar.put("/x", handler),
    ],
    [
      "patch",
      // @ts-expect-error - no `patch` on the registrar
      () => registrar.patch("/x", handler),
    ],
    [
      "delete",
      // @ts-expect-error - no `delete` on the registrar
      () => registrar.delete("/x", handler),
    ],
    [
      "head",
      // @ts-expect-error - no `head` on the registrar
      () => registrar.head("/x", handler),
    ],
    [
      "options",
      // @ts-expect-error - no `options` on the registrar
      () => registrar.options("/x", handler),
    ],
    [
      "all",
      // @ts-expect-error - no `all` on the registrar
      () => registrar.all("/x", handler),
    ],
    [
      "get",
      // @ts-expect-error - no `get` with a reply type of its own either
      () => registrar.get<{ Reply: { status: "ok" } }>("/x", handler),
    ],
    [
      "route",
      // @ts-expect-error - no `route` on the registrar
      () => registrar.route({ method: "GET", url: "/x", handler }),
    ],
    [
      "withTypeProvider",
      // @ts-expect-error - no `withTypeProvider` on the registrar
      () => registrar.withTypeProvider<ZodTypeProvider>(),
    ],
    [
      "get",
      // @ts-expect-error - no `get` reached through optional chaining
      () => registrar?.get("/x", handler),
    ],
    [
      "get",
      () =>
        registrar
          // @ts-expect-error - no `get` on the next line of the chain either
          .get("/x", handler),
    ],
    [
      "get",
      // biome-ignore format: the form under test is the call opened on the line after `app.get` (E0-12P, DoD p.3)
      () =>
        // @ts-expect-error - no `get`, with the call opened on the next line
        registrar.get
          ("/x", handler),
    ],
    [
      "get",
      () => {
        // @ts-expect-error - no `get` to take off the registrar
        const { get } = registrar;
        return get("/x", handler);
      },
    ],
    [
      "get",
      // @ts-expect-error - no `get` to `call`
      () => registrar.get.call(registrar, "/x", { handler }),
    ],
    [
      "get",
      // @ts-expect-error - no `get` to `bind`
      () => registrar.get.bind(registrar)("/x", handler),
    ],
    [
      "get",
      () => {
        const key = "get";
        // @ts-expect-error - no `get` behind brackets either
        return registrar[key]("/x", handler);
      },
    ],
    [
      "register",
      // @ts-expect-error - no `register`: a plugin of a module is a plugin of the app (`src/plugins`)
      () => registrar.register(async () => undefined),
    ],
    [
      "addHook",
      // @ts-expect-error - no `addHook`: a hook of a route goes in its definition
      () => registrar.addHook("onRequest", async () => undefined),
    ],
    [
      "decorate",
      // @ts-expect-error - no `decorate`: decorations belong to the app
      () => registrar.decorate("x", 1),
    ],
    [
      "setErrorHandler",
      // @ts-expect-error - no `setErrorHandler`: the error envelope rests on it
      () => registrar.setErrorHandler(() => undefined),
    ],
    [
      "setSerializerCompiler",
      // @ts-expect-error - no `setSerializerCompiler`: the error envelope rests on it
      () => registrar.setSerializerCompiler(() => () => ""),
    ],
    [
      "setValidatorCompiler",
      // @ts-expect-error - no `setValidatorCompiler`: the error envelope rests on it
      () => registrar.setValidatorCompiler(() => () => ({ value: undefined })),
    ],
    [
      "setSchemaErrorFormatter",
      // @ts-expect-error - no `setSchemaErrorFormatter`: the error envelope rests on it
      () => registrar.setSchemaErrorFormatter(() => new Error("x")),
    ],
    ["delete", () => registerThroughThis.call(registrar)],
  ];
}

/** The methods the bait below was called by, in order. */
const baitCalls: string[] = [];

/**
 * A registrar with every method: a `Proxy` over a real one that answers any
 * name with a function recording it. The bypass cases run on it to show
 * which method each reaches for; typed as the registrar it wraps, so the
 * cases take it as they are, without a cast.
 */
function bait(registrar: RouteRegistrar): RouteRegistrar {
  return new Proxy(registrar, {
    get: (_target, name) =>
      typeof name === "string"
        ? () => {
            baitCalls.push(name);
          }
        : undefined,
  });
}

/** The urls the bypass cases above would register, were any of them to work. */
const BYPASS_URLS = ["/x", "/through-this"];

/** The keys of the instance a route could be registered or the app changed with. */
const INSTANCE_KEYS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
  "route",
  "withTypeProvider",
  "register",
  "addHook",
  "decorate",
  "setErrorHandler",
  "setSerializerCompiler",
  "setValidatorCompiler",
  "setSchemaErrorFormatter",
] as const;

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
            routeRegistrar(child),
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

  it("registers the routes whose types are checked, and the typed ones answer", async () => {
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          compileTimeCases(routeRegistrar(child));
        });
      },
    });
    try {
      const headers = { authorization: AUTH_HEADER };
      const typed = await app.inject({
        method: "GET",
        url: "/typed/abc",
        headers,
      });
      const neighbours = await app.inject({
        method: "GET",
        url: "/neighbours?id=a",
        headers,
      });
      expect(typed.statusCode).toBe(OK_STATUS);
      expect(typed.json()).toEqual({ status: "ok" });
      expect(neighbours.statusCode).toBe(OK_STATUS);
      expect(neighbours.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("registers the route with its responses as schema.response, its mark and its reply headers", async () => {
    const seen: unknown[] = [];
    const schemas: unknown[] = [];
    const marks: unknown[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          if (route.url === "/defined" && route.method === "GET") {
            seen.push(route.schema?.response);
            schemas.push(route.schema);
            marks.push(isDefinedRoute(route.config));
          }
        });
        root.register(async (child) => {
          defineRoute(
            routeRegistrar(child),
            {
              method: "GET",
              url: "/defined",
              responses,
              schema: { summary: "a route", tags: ["test"] },
              replyHeaders: { "cache-control": "no-store" },
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
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(seen).toEqual([responses]);
      expect(marks).toEqual([true]);
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

  it("sets no hook of its own on a route without reply headers or with none in them", async () => {
    const hooks = new Map<string, unknown>();
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          if (route.method === "GET") hooks.set(route.url, route.onSend);
        });
        root.register(async (child) => {
          const registrar = routeRegistrar(child);
          defineRoute(
            registrar,
            { method: "GET", url: "/no-headers", responses, schema: {} },
            async () => ({ status: "ok" as const }),
          );
          defineRoute(
            registrar,
            {
              method: "GET",
              url: "/empty-headers",
              responses,
              schema: {},
              replyHeaders: {},
            },
            async () => ({ status: "ok" as const }),
          );
          defineRoute(
            registrar,
            {
              method: "GET",
              url: "/with-headers",
              responses,
              schema: {},
              replyHeaders: { "cache-control": "no-store" },
            },
            async () => ({ status: "ok" as const }),
          );
        });
      },
    });
    try {
      await app.ready();
      expect(hooks.get("/no-headers")).toBeUndefined();
      expect(hooks.get("/empty-headers")).toBeUndefined();
      // The route the two above are told from: the hook is there with headers.
      expect(typeof hooks.get("/with-headers")).toBe("function");
    } finally {
      await app.close();
    }
  });

  it("keeps the reply headers it was given, not the object they came in", async () => {
    const replyHeaders: { "cache-control": "no-store" } = {
      "cache-control": "no-store",
    };
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          defineRoute(
            routeRegistrar(child),
            {
              method: "GET",
              url: "/copied",
              responses,
              schema: {},
              replyHeaders,
            },
            async () => ({ status: "ok" as const }),
          );
          // A value the type refuses, so that the answer would show it.
          Reflect.set(replyHeaders, "cache-control", "public, max-age=60");
        });
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/copied",
        headers: { authorization: AUTH_HEADER },
      });
      expect(Reflect.get(replyHeaders, "cache-control")).toBe(
        "public, max-age=60",
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("reads the reply headers once: what it checked is what the answer carries", async () => {
    // A getter that answers the allowed value on the first read and one the
    // check refuses on the next: a second read past the check would put the
    // answer into a shared cache.
    const reads: string[] = [];
    const replyHeaders = {};
    Object.defineProperty(replyHeaders, "cache-control", {
      enumerable: true,
      get: () => {
        reads.push("cache-control");
        return reads.length === 1 ? "no-store" : "public, max-age=86400";
      },
    });
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          defineRoute(
            routeRegistrar(child),
            {
              method: "GET",
              url: "/read-once",
              responses,
              schema: {},
              replyHeaders,
            },
            async () => ({ status: "ok" as const }),
          );
        });
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/read-once",
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(reads).toEqual(["cache-control"]);
    } finally {
      await app.close();
    }
  });

  it("throws on an option of the app or a hook on the body however it comes in, and registers nothing", async () => {
    const thrown: string[] = [];
    const registered: string[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          registered.push(route.url);
        });
        root.register(async (child) => {
          for (const register of appOptionCases(routeRegistrar(child))) {
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
      const ofTheApp = "an option of the app, the error envelope rests on it";
      const onTheBody =
        "a hook that may rewrite the body, headers go in replyHeaders";
      const cases = [
        ["/own-error-handler", "errorHandler", ofTheApp],
        ["/own-serializer", "serializerCompiler", ofTheApp],
        ["/own-validator", "validatorCompiler", ofTheApp],
        ["/own-formatter", "schemaErrorFormatter", ofTheApp],
        ["/attach-validation", "attachValidation", ofTheApp],
        ["/through-spread", "errorHandler", ofTheApp],
        ["/through-cast", "attachValidation", ofTheApp],
        ["/own-on-send", "onSend", onTheBody],
        ["/own-pre-serialization", "preSerialization", onTheBody],
        ["/on-send-through-spread", "onSend", onTheBody],
        ["/pre-serialization-through-spread", "preSerialization", onTheBody],
      ];
      expect(thrown).toEqual(
        cases.map(
          ([url, key, reason]) =>
            `route GET ${url}: refused in a route - ${key} (${reason})`,
        ),
      );
      const urls = cases.map(([url]) => url);
      expect(registered.filter((url) => urls.includes(url))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("throws on a reply header a route does not set, by name or by value, however it comes in, and registers nothing", async () => {
    const thrown: string[] = [];
    const registered: string[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          registered.push(route.url);
        });
        root.register(async (child) => {
          for (const register of replyHeaderCases(routeRegistrar(child))) {
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
      // The name and the value as they came in, the value as JSON: a line
      // break in it stays on the one line of the message.
      const cases = [
        ["/own-content-length", 'content-length: "5"'],
        ["/own-public-cache", 'cache-control: "public, max-age=86400"'],
        ["/content-length-past-type", 'content-length: "5"'],
        ["/content-type-past-type", 'content-type: "text/plain"'],
        ["/set-cookie-past-type", 'set-cookie: "a=1"'],
        ["/request-id-past-type", `${REQUEST_ID_HEADER}: "forged"`],
        ["/capital-past-type", 'Cache-Control: "no-store"'],
        ["/line-break-past-type", 'cache-control: "no-store\\r\\nx: y"'],
        ["/undefined-past-type", "cache-control: undefined"],
        ["/public-past-type", 'cache-control: "public, max-age=86400"'],
        ["/empty-past-type", 'cache-control: ""'],
        ["/null-prototype-past-type", "set-cookie: object"],
      ];
      expect(thrown).toEqual(
        cases.map(
          ([url, header]) =>
            `route GET ${url}: reply headers a route does not set (${header}) - only cache-control: no-store`,
        ),
      );
      const urls = cases.map(([url]) => url);
      expect(registered.filter((url) => urls.includes(url))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("hands a module a registrar without a single key of the instance", async () => {
    const seen: Array<{ keys: unknown[]; values: unknown[]; frozen: boolean }> =
      [];
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          const registrar = routeRegistrar(child);
          seen.push({
            keys: Reflect.ownKeys(registrar),
            values: INSTANCE_KEYS.map((key) => Reflect.get(registrar, key)),
            frozen: Object.isFrozen(registrar),
          });
        });
      },
    });
    try {
      await app.ready();
      expect(seen).toEqual([
        {
          keys: [],
          values: INSTANCE_KEYS.map(() => undefined),
          frozen: true,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("throws on every way past defineRoute for the missing method itself, and registers nothing", async () => {
    const thrown: string[] = [];
    const reached: string[][] = [];
    const expected: string[] = [];
    const registered: string[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          registered.push(route.url);
        });
        root.register(async (child) => {
          const registrar = routeRegistrar(child);
          for (const [method, run] of registrarBypassCases(registrar)) {
            expected.push(method);
            try {
              run();
              thrown.push("no error");
            } catch (error) {
              thrown.push(error instanceof TypeError ? "TypeError" : "other");
            }
          }
          for (const [, run] of registrarBypassCases(bait(registrar))) {
            baitCalls.length = 0;
            run();
            reached.push([...baitCalls]);
          }
        });
      },
    });
    try {
      await app.ready();
      expect(expected.length).toBeGreaterThan(0);
      // On the registrar every case throws a `TypeError`; on the bait, which
      // has the methods, each reaches the one it names and nothing else - so
      // the `TypeError` above is the method missing, not a case broken.
      expect(thrown).toEqual(expected.map(() => "TypeError"));
      expect(reached).toEqual(expected.map((method) => [method]));
      expect(registered.filter((url) => BYPASS_URLS.includes(url))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("throws on a registrar it did not make, and registers nothing", async () => {
    const thrown: string[] = [];
    const registered: string[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          registered.push(route.url);
        });
        root.register(async (child) => {
          const copy: RouteRegistrar = { ...routeRegistrar(child) };
          const forged = Object.freeze({}) as RouteRegistrar;
          const fakes = [
            ["/copied", copy],
            ["/forged", forged],
          ] as const;
          for (const [url, registrar] of fakes) {
            try {
              defineRoute(
                registrar,
                { method: "GET", url, responses, schema: {} },
                async () => ({ status: "ok" as const }),
              );
            } catch (error) {
              thrown.push(error instanceof Error ? error.message : "");
            }
          }
        });
      },
    });
    try {
      await app.ready();
      expect(thrown).toEqual(
        ["/copied", "/forged"].map(
          (url) =>
            `route GET ${url}: not a registrar made by routeRegistrar - a route is registered on the context the app hands over`,
        ),
      );
      expect(
        registered.filter((url) => url === "/copied" || url === "/forged"),
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("knows the config of a route it registered, and not a copy of it or anything else", async () => {
    const configs: unknown[] = [];
    const app = buildTestApp({
      routes: (root) => {
        root.addHook("onRoute", (route) => {
          if (route.url === "/known") configs.push(route.config);
        });
        root.register(async (child) => {
          defineRoute(
            routeRegistrar(child),
            { method: "GET", url: "/known", responses, schema: {} },
            async () => ({ status: "ok" as const }),
          );
        });
      },
    });
    try {
      await app.ready();
      // The GET and its HEAD twin, one config.
      expect(configs).toHaveLength(2);
      const [config] = configs;
      expect(configs.map((value) => isDefinedRoute(value))).toEqual([
        true,
        true,
      ]);
      // A copy carries whatever keys the config has, and is still refused.
      expect(isDefinedRoute(Object.assign({}, config))).toBe(false);
      expect(
        [{}, null, undefined, "config", 1].map((value) =>
          isDefinedRoute(value),
        ),
      ).toEqual([false, false, false, false, false]);
    } finally {
      await app.close();
    }
  });
});
