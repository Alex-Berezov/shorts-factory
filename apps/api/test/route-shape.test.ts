// `schema.hide` of a route below is a field `@fastify/swagger` adds to the
// schema of Fastify by augmenting its types; named here rather than reached
// through the import chain of `src/app.ts`.
import type {} from "@fastify/swagger";
import { ErrorBodySchema, HealthResponseSchema } from "@sf/contracts";
import Fastify, { type RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppInstance } from "../src/app.js";
import {
  OK_STATUS,
  errorResponses,
  withErrorEnvelope,
} from "../src/lib/route-schemas.js";
import {
  DOCS_ROUTE,
  OPENAPI_ROUTE,
  registerOpenapi,
} from "../src/plugins/openapi.js";
import { buildTestApp } from "./helpers.js";

/**
 * The error envelope on every failure status of every route, checked on what
 * Fastify registered rather than on the text of the route files: a computed
 * key (`[HEALTH_STATUS_CODES.degraded]`) is beyond a pattern over a line, and
 * the rule of `rules.sf.json` (S14) only says whether `...errorResponses()` is
 * in the file at all. What a route must declare (`src/routes/README.md`,
 * `src/lib/route-schemas.ts`):
 *
 * - `4xx` and `5xx`, each the error envelope - `ErrorBodySchema` of
 *   `@sf/contracts`, the schema `errorResponses()` spreads;
 * - every exact key from 400 to 599 the envelope itself or a union with the
 *   envelope among its options, at any depth - the form `withErrorEnvelope()`
 *   builds, and the same thing written as `.or(ErrorBodySchema)`: an exact key
 *   wins over the wildcard for the whole status, and without the envelope a
 *   failure carrying that status is answered as a 500 by the framework;
 * - an `OK_STATUS` key, which `SuccessReply` reads the reply type from;
 * - no `default` key. Fastify picks the schema of a reply by its exact status,
 *   then by its class (`2xx`, `4xx`), then `default`
 *   (`fastify/lib/schemas.js`, `getSchemaSerializer`); with `4xx` and `5xx`
 *   declared, `default` is reached by a 1xx-3xx status alone - a success or a
 *   redirect, never a failure - so it is refused, whatever it holds, and the
 *   success status is named instead.
 *
 * A key is read the way Fastify reads it, lowercased (`4XX` is `4xx`), the
 * last of a name winning.
 *
 * The envelope is recognised by its structure, not by the identity of the
 * object or by `instanceof`: a copy of its shape, or a schema built by a
 * second copy of zod, serializes a failure just the same, while a schema of
 * another shape - a success body, an envelope with a field of its own -
 * does not.
 */
function routeShapeViolations(response: unknown): string[] {
  if (typeof response !== "object" || response === null) {
    return ["no schema.response"];
  }
  // By the key Fastify serializes with: it lowercases each key (`4XX` is
  // `4xx`) and a later key of the same name replaces an earlier one
  // (`lib/validation.js`, `compileSchemasForSerialization`).
  const declared = new Map<string, unknown>();
  for (const [key, schema] of Object.entries(response)) {
    declared.set(key.toLowerCase(), schema);
  }
  const violations: string[] = [];
  for (const wildcard of ["4xx", "5xx"]) {
    if (!isEnvelope(declared.get(wildcard))) {
      violations.push(`${wildcard} is not the error envelope`);
    }
  }
  if (!declared.has(String(OK_STATUS))) {
    violations.push(`no ${OK_STATUS}`);
  }
  if (declared.has("default")) {
    violations.push(
      "default is refused: with 4xx and 5xx declared it answers 1xx-3xx only - name the success status",
    );
  }
  for (const [key, schema] of declared) {
    const status = Number(key);
    const failure = Number.isInteger(status) && status >= 400 && status <= 599;
    if (failure && !carriesEnvelope(schema)) {
      violations.push(`${key} has no error envelope`);
    }
  }
  return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The definition of a zod schema, by the field every zod 3 schema carries
 * (`_def.typeName`) rather than by `instanceof`, which a schema of a second
 * copy of zod fails; null for anything else.
 */
function definitionOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !("_def" in value)) return null;
  const definition = value._def;
  return isRecord(definition) && typeof definition.typeName === "string"
    ? definition
    : null;
}

/**
 * A zod schema as plain data: its kind, the checks on it, the schemas inside
 * it, the keys of an object - everything that decides what it accepts. What
 * does not is left out: the description and the error map. A function inside
 * (a refinement, a lazy getter) cannot be compared and stands as a marker; a
 * regular expression (`z.string().regex(...)`) stands as its source and
 * flags, which are what it accepts - as an object it has no keys of its own
 * and would compare equal to every other.
 */
function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  const definition = definitionOf(value);
  if (definition !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(definition).sort()) {
      if (key === "description" || key === "errorMap" || key === "shape") {
        continue;
      }
      out[key] = structure(definition[key]);
    }
    // `_def.shape` of an object is a function; the schema exposes the keys.
    if (isRecord(value) && "shape" in value) out.shape = structure(value.shape);
    return out;
  }
  if (typeof value === "function") return "<function>";
  if (value instanceof RegExp) return `<regexp ${String(value)}>`;
  if (value instanceof Map) return "<map>";
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, structure(value[key])]),
    );
  }
  return value;
}

const ENVELOPE = JSON.stringify(structure(ErrorBodySchema));

/** Whether `schema` is the error envelope, by structure. */
function isEnvelope(schema: unknown): boolean {
  return (
    definitionOf(schema) !== null &&
    JSON.stringify(structure(schema)) === ENVELOPE
  );
}

/**
 * Whether a failure with the status of `schema` serializes as the envelope:
 * `schema` is the envelope, or a union (`z.union`, `.or`,
 * `z.discriminatedUnion`) with an option that carries it.
 */
function carriesEnvelope(schema: unknown): boolean {
  if (isEnvelope(schema)) return true;
  const definition = definitionOf(schema);
  if (
    definition === null ||
    (definition.typeName !== "ZodUnion" &&
      definition.typeName !== "ZodDiscriminatedUnion")
  ) {
    return false;
  }
  const options = definition.options;
  return Array.isArray(options) && options.some(carriesEnvelope);
}

/** The envelope written out again: the same shape, another object. */
function envelopeCopy() {
  return z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().min(1),
      details: z.unknown().optional(),
    }),
  });
}

describe("routeShapeViolations", () => {
  it("passes the form of /health: wildcards, 200, enveloped 503", () => {
    expect(
      routeShapeViolations({
        ...errorResponses(),
        200: HealthResponseSchema,
        503: withErrorEnvelope(HealthResponseSchema),
      }),
    ).toEqual([]);
  });

  it.each([
    ["written with .or", HealthResponseSchema.or(ErrorBodySchema)],
    [
      "a copy of its shape in the union",
      z.union([HealthResponseSchema, envelopeCopy()]),
    ],
    [
      "inside a nested union",
      z.union([z.string(), withErrorEnvelope(HealthResponseSchema)]),
    ],
    ["the envelope itself", ErrorBodySchema],
  ])("passes an exact failure status with the envelope %s", (_how, schema) => {
    expect(
      routeShapeViolations({
        ...errorResponses(),
        200: HealthResponseSchema,
        404: schema,
      }),
    ).toEqual([]);
  });

  it("passes wildcards holding a copy of the envelope", () => {
    expect(
      routeShapeViolations({
        "4xx": envelopeCopy(),
        "5xx": ErrorBodySchema.extend({}),
        200: HealthResponseSchema,
      }),
    ).toEqual([]);
  });

  it("refuses an exact failure status without the envelope", () => {
    expect(
      routeShapeViolations({
        ...errorResponses(),
        200: HealthResponseSchema,
        503: HealthResponseSchema,
      }),
    ).toEqual(["503 has no error envelope"]);
  });

  it.each([
    [
      "a union of the success shape with another error shape",
      z.union([HealthResponseSchema, z.object({ error: z.string() })]),
    ],
    [
      "a union with an envelope that lost a check",
      z.union([
        HealthResponseSchema,
        z.object({
          error: z.object({
            code: z.string(),
            message: z.string(),
            requestId: z.string(),
            details: z.unknown().optional(),
          }),
        }),
      ]),
    ],
    [
      "a union with an envelope that has a field of its own",
      z.union([
        HealthResponseSchema,
        ErrorBodySchema.extend({ x: z.string() }),
      ]),
    ],
    [
      "a discriminated union without the envelope",
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("a") }),
        z.object({ status: z.literal("b") }),
      ]),
    ],
    ["the envelope behind a refinement", ErrorBodySchema.refine(() => true)],
  ])("refuses an exact failure status with %s", (_what, schema) => {
    expect(
      routeShapeViolations({
        ...errorResponses(),
        200: HealthResponseSchema,
        404: schema,
      }),
    ).toEqual(["404 has no error envelope"]);
  });

  it.each(["4xx", "5xx"])("refuses a route without the %s wildcard", (key) => {
    const responses: Record<string, z.ZodTypeAny> = {
      ...errorResponses(),
      200: HealthResponseSchema,
    };
    delete responses[key];
    expect(routeShapeViolations(responses)).toEqual([
      `${key} is not the error envelope`,
    ]);
  });

  it("refuses a wildcard of another shape", () => {
    expect(
      routeShapeViolations({
        "4xx": ErrorBodySchema,
        "5xx": HealthResponseSchema,
        200: HealthResponseSchema,
      }),
    ).toEqual(["5xx is not the error envelope"]);
  });

  it("refuses a route without the success status", () => {
    expect(
      routeShapeViolations({
        ...errorResponses(),
        201: HealthResponseSchema,
      }),
    ).toEqual(["no 200"]);
  });

  it("refuses a default key", () => {
    const refused =
      "default is refused: with 4xx and 5xx declared it answers 1xx-3xx only - name the success status";
    // Whatever it holds: the envelope would serialize a 201 or a 204 as a
    // failure, and a success body is still a status the route leaves unnamed.
    for (const schema of [ErrorBodySchema, HealthResponseSchema]) {
      expect(
        routeShapeViolations({
          ...errorResponses(),
          200: HealthResponseSchema,
          default: schema,
        }),
      ).toEqual([refused]);
    }
  });

  it("reads an upper-case wildcard as the wildcard it replaces", () => {
    // Declared after `...errorResponses()`, `4XX` is the `4xx` Fastify keeps.
    expect(
      routeShapeViolations({
        ...errorResponses(),
        200: HealthResponseSchema,
        "4XX": HealthResponseSchema,
      }),
    ).toEqual(["4xx is not the error envelope"]);
  });

  it("refuses a route without schema.response", () => {
    expect(routeShapeViolations(undefined)).toEqual(["no schema.response"]);
  });
});

describe("structure", () => {
  it("tells apart schemas that differ only in the pattern of a check", () => {
    const envelopeWith = (pattern: RegExp) =>
      z.object({ error: z.object({ requestId: z.string().regex(pattern) }) });
    expect(JSON.stringify(structure(envelopeWith(/^a$/)))).not.toBe(
      JSON.stringify(structure(envelopeWith(/^b$/))),
    );
    expect(JSON.stringify(structure(envelopeWith(/^a$/)))).toBe(
      JSON.stringify(structure(envelopeWith(/^a$/))),
    );
  });
});

/** `METHOD url` of a route; the methods of a route with several, joined by a comma. */
function routeKey(route: RouteOptions): string {
  return `${[route.method].flat().join(",")} ${route.url}`;
}

/**
 * The routes the documentation plugins register - `/docs` and what is under
 * it, `/openapi.json`, the HEAD twins of each - read off an instance that has
 * nothing else on it, by `METHOD url`.
 */
async function documentationRoutes(): Promise<Set<string>> {
  const app = Fastify();
  const keys = new Set<string>();
  try {
    app.addHook("onRoute", (route) => {
      keys.add(routeKey(route));
    });
    registerOpenapi(app, { version: null });
    await app.ready();
  } finally {
    await app.close();
  }
  return keys;
}

/**
 * The routes of an app as Fastify registered them, without those of the
 * documentation plugins - left out by exact method and url
 * (`documentationRoutes`), so a route of `src/routes` under `/docs/`, an
 * explicit `HEAD` route and a route of several methods all stay in. The HEAD
 * twin Fastify adds to a GET route is checked like the route itself: it
 * carries the same schema. Not by `schema.hide` either: a route of
 * `src/routes` hidden from the document is still a route whose failures must
 * serialize. `extra` registers more routes, the way a module of `src/routes`
 * would.
 */
async function ownRoutes(
  extra?: (app: AppInstance) => void,
): Promise<RouteOptions[]> {
  const documentation = await documentationRoutes();
  const app = buildTestApp();
  const registered: RouteOptions[] = [];
  try {
    // Before `ready()`: the routes go into a child context that loads during
    // `ready()` and inherits the hooks of the root at that moment.
    app.addHook("onRoute", (route) => {
      registered.push(route);
    });
    if (extra !== undefined) {
      app.register(async (child) => {
        extra(child);
      });
    }
    await app.ready();
  } finally {
    await app.close();
  }
  return registered.filter((route) => !documentation.has(routeKey(route)));
}

/** Entries in the order of their route, for a comparison as a set. */
function byRoute<T extends { route: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.route.localeCompare(b.route));
}

function shapes(routes: RouteOptions[]) {
  return routes.map((route) => ({
    route: routeKey(route),
    violations: routeShapeViolations(route.schema?.response),
  }));
}

describe("routes of the registry", () => {
  it("knows the routes of the documentation it leaves out", async () => {
    // An empty set would leave out nothing and the list below would say so;
    // a set that missed the document would put it among the routes.
    const documentation = await documentationRoutes();
    expect(documentation).toContain(`GET ${OPENAPI_ROUTE}`);
    expect(documentation).toContain(`GET ${DOCS_ROUTE}`);
    expect(documentation).toContain(`HEAD ${DOCS_ROUTE}`);
  });

  it("sees exactly the routes the registry declares, each in shape", async () => {
    // A hook that saw nothing would pass on no routes: the list is exact,
    // and compared as a set - the order Fastify registers in is not ours.
    expect(byRoute(shapes(await ownRoutes()))).toEqual(
      byRoute([
        { route: "GET /health", violations: [] },
        { route: "HEAD /health", violations: [] },
        { route: "GET /system/status", violations: [] },
        { route: "HEAD /system/status", violations: [] },
      ]),
    );
  });

  it("checks an explicit HEAD route, a route of several methods and a route under /docs/", async () => {
    const bare = {
      response: { 200: HealthResponseSchema, 503: HealthResponseSchema },
    };
    const violations = [
      "4xx is not the error envelope",
      "5xx is not the error envelope",
      "503 has no error envelope",
    ];
    const routes = await ownRoutes((app) => {
      app.head("/explicit-head", { schema: bare }, async () => undefined);
      app.route({
        method: ["GET", "POST"],
        url: "/several",
        schema: bare,
        handler: async () => ({ status: "ok" as const }),
      });
      app.get("/docs/own", { schema: bare }, async () => ({
        status: "ok" as const,
      }));
    });
    const seen = shapes(routes);
    expect(seen).toContainEqual({ route: "HEAD /explicit-head", violations });
    expect(seen).toContainEqual({ route: "GET,POST /several", violations });
    expect(seen).toContainEqual({ route: "GET /docs/own", violations });
  });

  it("checks a route hidden from the document like any other", async () => {
    const routes = await ownRoutes((app) => {
      app.get(
        "/hidden",
        {
          schema: {
            hide: true,
            response: { 200: HealthResponseSchema, 503: HealthResponseSchema },
          },
        },
        async () => ({ status: "ok" as const }),
      );
    });
    expect(shapes(routes)).toContainEqual({
      route: "GET /hidden",
      violations: [
        "4xx is not the error envelope",
        "5xx is not the error envelope",
        "503 has no error envelope",
      ],
    });
  });
});
