import { HealthResponseSchema } from "@sf/contracts";
import { describe, expect, it } from "vitest";
import type { AppInstance } from "../src/lib/app-instance.js";
import {
  OK_STATUS,
  defineRoute,
  errorResponses,
  routeRegistrar,
} from "../src/lib/define-route.js";
import { AUTH_HEADER, buildTestApp, unmappableError } from "./helpers.js";

/**
 * What Fastify does once the app is ready, measured rather than assumed
 * (docs/adr/0015-route-registrar.md): the instance a handler reaches through
 * `request.server` - the whole instance by its type, which the modules of
 * `src/routes` may not name (`route-modules.test.ts`) - refuses a route, a
 * hook, a plugin, a decoration and a handler or a compiler of the app; and
 * the answers of the error handlers pass the `onSend` of the route that
 * `defineRoute` sets its reply headers in.
 */

const responses = {
  ...errorResponses(),
  [OK_STATUS]: HealthResponseSchema,
};

/** The calls of the hook the `addHook` form below would add, were it added. */
const lateHookCalls: string[] = [];

/**
 * What a handler reaches through `request.server`, the whole instance by its
 * type: each form is called once the app is ready, under `inject`, and the
 * error is told by its `code`, not by its text. What a form would leave is
 * looked for on the context it was called on, the child the route is
 * registered in: a route at `/late`, a hook that records its calls, a
 * decoration `late`.
 */
const LATE_FORMS: ReadonlyArray<
  readonly [form: string, code: string, call: (server: AppInstance) => unknown]
> = [
  [
    "route",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) =>
      server.route({ method: "GET", url: "/late", handler: async () => ({}) }),
  ],
  [
    "get",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) => server.get("/late", async () => ({})),
  ],
  [
    "addHook",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) =>
      server.addHook("onRequest", async () => {
        lateHookCalls.push("onRequest");
      }),
  ],
  [
    "register",
    "AVV_ERR_ROOT_PLG_BOOTED",
    (server) =>
      server.register(async (plugin) => {
        plugin.get("/late", async () => ({}));
      }),
  ],
  [
    "decorate",
    "FST_ERR_DEC_AFTER_START",
    (server) => server.decorate("late", true),
  ],
  [
    "setErrorHandler",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) => server.setErrorHandler(() => ({ late: true })),
  ],
  [
    "setValidatorCompiler",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) => server.setValidatorCompiler(() => () => ({ value: true })),
  ],
  [
    "setSerializerCompiler",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) => server.setSerializerCompiler(() => () => "late"),
  ],
  [
    "setSchemaErrorFormatter",
    "FST_ERR_INSTANCE_ALREADY_LISTENING",
    (server) => server.setSchemaErrorFormatter(() => new Error("late")),
  ],
];

/** The `code` of what `run` threw, or that it did not throw. */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    // `register` hands back a thenable: its failure may come either way.
    await run();
    return "no error";
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String(error.code)
      : "an error without a code";
  }
}

/** Calls a form on the instance a handler reaches, twice, and looks for what it left in the child. */
async function reachLate(
  code: string,
  call: (server: AppInstance) => unknown,
): Promise<void> {
  const outcome: string[] = [];
  const children: AppInstance[] = [];
  const reachedChild: boolean[] = [];
  lateHookCalls.length = 0;
  const app = buildTestApp({
    routes: (root) => {
      root.register(async (child) => {
        children.push(child);
        defineRoute(
          routeRegistrar(child),
          { method: "GET", url: "/reach-server", responses, schema: {} },
          async (request) => {
            reachedChild.push(request.server === child);
            outcome.push(await codeOf(() => call(request.server)));
            return { status: "ok" as const };
          },
        );
      });
    },
  });
  try {
    const headers = { authorization: AUTH_HEADER };
    const reached = await app.inject({
      method: "GET",
      url: "/reach-server",
      headers,
    });
    // A hook added by the first call would run on the second.
    const again = await app.inject({
      method: "GET",
      url: "/reach-server",
      headers,
    });
    const late = await app.inject({ method: "GET", url: "/late", headers });
    expect([reached.statusCode, again.statusCode]).toEqual([
      OK_STATUS,
      OK_STATUS,
    ]);
    // The form was called on the child, where its trace is looked for.
    expect(reachedChild).toEqual([true, true]);
    expect(outcome).toEqual([code, code]);
    expect(late.statusCode).toBe(404);
    expect(lateHookCalls).toEqual([]);
    expect(children.map((child) => child.hasDecorator("late"))).toEqual([
      false,
    ]);
  } finally {
    await app.close();
  }
}

const TRACE_FORM_NAMES = ["route", "get", "addHook", "register", "decorate"];
const SET_FORM_NAMES = [
  "setErrorHandler",
  "setValidatorCompiler",
  "setSerializerCompiler",
  "setSchemaErrorFormatter",
];
const TRACE_FORMS = LATE_FORMS.filter(([form]) =>
  TRACE_FORM_NAMES.includes(form),
);
const SET_FORMS = LATE_FORMS.filter(([form]) => SET_FORM_NAMES.includes(form));

describe("the instance a handler reaches through request.server", () => {
  it.each(TRACE_FORMS)(
    "refuses %s once the app is ready, with %s, and the child keeps no route, hook or decoration of it",
    (_form, code, call) => reachLate(code, call),
  );

  it.each(SET_FORMS)(
    "refuses %s once the app is ready, with %s",
    (_form, code, call) => reachLate(code, call),
  );
});

describe("the reply headers of a route on the answers of the error handlers", () => {
  it("sets them on the answer of the app's error handler and of Fastify's own when the app's throws", async () => {
    // The error handler of a context that throws hands the failure to the
    // app's, and the app's handler that throws hands it to Fastify's default
    // one - both answers pass the `onSend` of the route
    // (docs/adr/0015-route-registrar.md, "Заголовки ответа").
    const replyHeaders = { "cache-control": "no-store" } as const;
    const app = buildTestApp({
      routes: (root) => {
        root.register(async (child) => {
          child.setErrorHandler(() => {
            throw new Error("the handler of the context failed");
          });
          defineRoute(
            routeRegistrar(child),
            {
              method: "GET",
              url: "/fails",
              responses,
              schema: {},
              replyHeaders,
            },
            async () => {
              throw new Error("the route failed");
            },
          );
        });
        // A context of its own: the app's handler gets the error the route
        // threw, not the one of a context handler.
        root.register(async (child) => {
          defineRoute(
            routeRegistrar(child),
            {
              method: "GET",
              url: "/fails-unmappably",
              responses,
              schema: {},
              replyHeaders,
            },
            async () => {
              throw unmappableError();
            },
          );
        });
      },
    });
    try {
      const headers = { authorization: AUTH_HEADER };
      const ours = await app.inject({ method: "GET", url: "/fails", headers });
      const fastifys = await app.inject({
        method: "GET",
        url: "/fails-unmappably",
        headers,
      });
      expect(ours.statusCode).toBe(500);
      expect(ours.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
      expect(ours.headers["cache-control"]).toBe("no-store");
      // The body of Fastify's default handler, not ours: the path measured is
      // its own.
      expect(fastifys.statusCode).toBe(500);
      expect(fastifys.json()).toMatchObject({
        code: "FST_ERR_FAILED_ERROR_SERIALIZATION",
      });
      expect(fastifys.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
