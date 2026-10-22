import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorBodySchema } from "@sf/contracts";
import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyContextConfig,
  FastifySchema,
  HTTPMethods,
  RawServerDefault,
  RouteHandlerMethod,
  RouteShorthandOptions,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppInstance } from "./app-instance.js";

/** The status a route answers with when nothing went wrong. */
export const OK_STATUS = 200;

/**
 * The body a handler must return, read off the responses it declares.
 *
 * Fastify infers the reply type of a handler from `schema.response`, but a
 * route here declares failures there as well (`errorResponses()` below), and
 * that inferred type is the union of every declared response: a handler that
 * returned an error envelope in place of the answer would compile. Stating
 * `Reply` in the route generic replaces the inferred type rather than
 * narrowing it (`fastify/types/type-provider.d.ts`, "can be explicitly
 * overridden"), so what is stated has to come from the same object the schema
 * is built from - `SuccessReply<Responses>`, not a type name written out a
 * second time next to it. `defineRoute` below does both from the one object
 * it is given, so there is one declaration and no pair to drift apart: the
 * schema at `OK_STATUS` decides both what is serialized and what the handler
 * is allowed to return, and a route whose responses have no `OK_STATUS` key
 * does not compile.
 *
 * What this does not do is check the other statuses: a body returned with
 * `reply.status(503).send(...)` is outside the reply type, and nothing but
 * the serializer reads the schema declared there.
 */
type SuccessReply<Responses extends Record<typeof OK_STATUS, z.ZodTypeAny>> =
  z.infer<Responses[typeof OK_STATUS]>;

/**
 * The failure half of every route's `schema.response`.
 *
 * A route that declares only its success shape leaves the error envelope
 * outside the contract twice over: `components.schemas` of the document stays
 * empty, so a generated client types failures by hand, and the zod serializer
 * has no schema for the status the error handler replies with - the first
 * route to declare an exact `404` would then have that 404 serialized against
 * the schema of another status and answered as a 500.
 *
 * Wildcards rather than a list of statuses: Fastify falls back from `429` to
 * `4xx` when no exact key matches (`lib/schemas.js`, `getSchemaSerializer`),
 * so a budget failure (429), a url the router refused (414) and every status
 * a plugin invents are covered without a route having to predict them.
 * Spreading this first leaves the exact keys of the route - `503` on
 * `/health` - in charge of their own statuses, which is what
 * `withErrorEnvelope` below is for.
 */
export function errorResponses(): {
  "4xx": typeof ErrorBodySchema;
  "5xx": typeof ErrorBodySchema;
} {
  return { "4xx": ErrorBodySchema, "5xx": ErrorBodySchema };
}

/**
 * A status a route answers with a body of its own, and the same status the
 * error handler can answer with.
 *
 * An exact key wins over the wildcard for the whole status, not for the happy
 * path of it: with `503: HealthResponseSchema` alone, a failure that leaves
 * `/health` with 503 - an `AppError` from a probe, an overload plugin - is
 * serialized against the health shape, fails to serialize, and reaches the
 * caller as `FST_ERR_FAILED_ERROR_SERIALIZATION` with a 500, no `requestId`
 * and the name of the framework in it. Declaring both shapes on that status
 * is what keeps the exact key and the envelope from excluding each other.
 */
export function withErrorEnvelope<Schema extends z.ZodTypeAny>(
  schema: Schema,
): z.ZodUnion<[Schema, typeof ErrorBodySchema]> {
  return z.union([schema, ErrorBodySchema]);
}

/** The responses of a route: `OK_STATUS` and whatever else it declares. */
type RouteResponses = Record<typeof OK_STATUS, z.ZodTypeAny>;

/**
 * The schema of a route without its responses: those come in `responses`
 * of `defineRoute`, and a second place to declare them is refused by type.
 */
type RouteSchema = Omit<FastifySchema, "response"> & {
  response?: never;
};

/** The reply a route generic states: the body at `OK_STATUS` and nothing else. */
interface SuccessGeneric<Responses extends RouteResponses> {
  Reply: SuccessReply<Responses>;
}

/** The schema Fastify gets: the route's own, with its responses. */
type DeclaredSchema<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
> = Schema & { response: Responses };

/** The reasons `REFUSED_OPTIONS` below gives, one per category. */
const APP_OPTION = "an option of the app, the error envelope rests on it";
const BODY_HOOK =
  "a hook that may rewrite the body, headers go in replyHeaders";

/**
 * The keys a route definition may not carry, each with its reason - one
 * table, so a new category is a row and not a second copy of the check.
 * `RouteExtras` leaves them out, so a literal that passes one does not
 * compile, and `defineRoute` throws on one that comes in past the type (a
 * spread, a cast), before anything is registered.
 *
 * The options the error envelope rests on belong to the app. The hooks that
 * get the serialized body may hand back another: an envelope rewritten there
 * leaves the route in a shape the document does not state, with nothing in
 * the type or the serializer to say so; the headers a route sets go in
 * `replyHeaders` instead, which `defineRoute` sets in a hook of its own that
 * hands the body back untouched.
 */
const REFUSED_OPTIONS = {
  errorHandler: APP_OPTION,
  serializerCompiler: APP_OPTION,
  validatorCompiler: APP_OPTION,
  schemaErrorFormatter: APP_OPTION,
  attachValidation: APP_OPTION,
  onSend: BODY_HOOK,
  preSerialization: BODY_HOOK,
} as const;

/**
 * The headers a route may set in `replyHeaders`, each with the values it may
 * take. A table of what is allowed rather than of what is not:
 * `content-type`, `content-length`, `content-encoding`, `transfer-encoding`
 * describe the body the serializer wrote, `set-cookie` and the request id
 * header belong to the app, and a value set last by the route would replace
 * theirs on the very answers the envelope travels in. A value is one of the
 * list too: a line break in it fails every answer of the route in Node, and
 * `public, max-age=...` would put an answer behind basic auth into a shared
 * cache. A name or a value joins the table by a new ADR
 * (docs/adr/0015-route-registrar.md, "Заголовки ответа"); both are compared
 * as written, the name lowercase.
 *
 * The table holds the option `replyHeaders` alone: a header off it there
 * does not compile and is thrown on. `reply.header`, `reply.removeHeader`,
 * `reply.type` and `reply.serializer` in the handler and in the hooks a
 * route may have (`onRequest`, `preValidation`, `preHandler`, `onError`)
 * are open - review holds them (docs/TECH_DEBT.md, open -> E0-12V).
 */
const REPLY_HEADERS = {
  "cache-control": ["no-store"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Headers of `replyHeaders`: names and values from `REPLY_HEADERS` only. */
type ReplyHeaders = Readonly<
  Partial<{
    [Name in keyof typeof REPLY_HEADERS]: (typeof REPLY_HEADERS)[Name][number];
  }>
>;

/** Whether `value` is one of the values `REPLY_HEADERS` allows for `name`. */
function allowedHeader(name: string, value: unknown): boolean {
  const values: Readonly<Record<string, readonly string[]>> = REPLY_HEADERS;
  return (
    Object.hasOwn(values, name) &&
    typeof value === "string" &&
    (values[name] ?? []).includes(value)
  );
}

/**
 * The configs of the routes `defineRoute` registered. Not exported: a route
 * cannot be marked from outside this module, by a key or otherwise, and
 * `isDefinedRoute` is the only way to ask.
 */
const definedConfigs = new WeakSet<object>();

/**
 * Whether `config` - of a route as Fastify hands it to an `onRoute` hook - is
 * the one `defineRoute` registered the route with. A module of `src/routes`
 * cannot register past the helper by type; any other code handed the
 * instance is held by `test/route-shape.test.ts`, which refuses a route this
 * says no to. A copy of the config of a defined route is not the config.
 */
export function isDefinedRoute(config: unknown): boolean {
  return (
    typeof config === "object" && config !== null && definedConfigs.has(config)
  );
}

/**
 * The options Fastify takes for the route, typed with the same generic and
 * schema as the handler: the hooks (`onRequest`, `preHandler`, `onError`,
 * `onResponse`), `bodyLimit`, `config` and the rest, without `schema`, which
 * `defineRoute` assembles, and without `REFUSED_OPTIONS`.
 */
type RouteExtras<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
> = Omit<
  RouteShorthandOptions<
    RawServerDefault,
    IncomingMessage,
    ServerResponse,
    SuccessGeneric<Responses>,
    ContextConfigDefault,
    DeclaredSchema<Schema, Responses>,
    ZodTypeProvider,
    FastifyBaseLogger
  >,
  "schema" | keyof typeof REFUSED_OPTIONS
>;

/** What a route module says about one route, besides its handler. */
type RouteDefinition<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
> = RouteExtras<Schema, Responses> & {
  method: HTTPMethods | HTTPMethods[];
  url: string;
  /** `{ ...errorResponses(), [OK_STATUS]: Schema, ... }` - `schema.response` of the route. */
  responses: Responses;
  /** The rest of the schema: summary, tags, params, body, querystring. */
  schema: Schema;
  /**
   * Headers set, with the body untouched, on the answers that pass the
   * `onSend` of the route: the handler's, those of its hooks (the 503 of a
   * closing service), the app's error handler's and - measured in
   * `test/instance-after-ready.test.ts` - Fastify's own default handler when the
   * app's throws. Not on an answer that leaves before a route is found (a
   * 404 of an unknown url, a url the router refused). Names and values from
   * `REPLY_HEADERS` only.
   */
  replyHeaders?: ReplyHeaders;
};

/** The handler of a route: request typed from the schema, reply from `SuccessReply`. */
type RouteHandler<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
> = RouteHandlerMethod<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  SuccessGeneric<Responses>,
  ContextConfigDefault,
  DeclaredSchema<Schema, Responses>,
  ZodTypeProvider,
  FastifyBaseLogger
>;

declare const registrarBrand: unique symbol;

/**
 * What a module of `src/routes` gets in place of the app: a token that
 * `defineRoute` takes and nothing else does. It has no key of the instance -
 * no `get` or `route`, no `withTypeProvider`, `register`, `addHook`,
 * `decorate`, no `set*` handler or compiler - so a registration past the
 * helper does not compile, and a cast to the instance finds nothing at run
 * time either: the instance stays in `instances` below, which this module
 * does not export (docs/adr/0015-route-registrar.md).
 */
export interface RouteRegistrar {
  readonly [registrarBrand]: true;
}

/** The instance behind each registrar `routeRegistrar` handed out. */
const instances = new WeakMap<RouteRegistrar, AppInstance>();

/**
 * The registrar over one context of the app: `app.ts` makes one over the
 * child context the routes are registered in, so that `@fastify/swagger`
 * sees them, and passes it to `registerRoutes`. The only way to make one.
 */
export function routeRegistrar(instance: AppInstance): RouteRegistrar {
  // The brand is a type alone: no value carries `registrarBrand`, and the
  // registrar is told from any other object by `instances`, not by a key.
  const registrar = Object.freeze({}) as RouteRegistrar;
  instances.set(registrar, instance);
  return registrar;
}

/**
 * The one way a module of `src/routes` registers a route.
 *
 * The responses come in as one object, go into `schema.response`, and the
 * reply type of the handler is read off that same object (`SuccessReply`), so
 * the two cannot drift apart and a handler returning the error envelope - a
 * declared response too - does not compile. `Params`, `Body` and
 * `Querystring` of the request still come from the zod schemas through the
 * type provider. The options the error envelope rests on - `errorHandler`,
 * the serializer and validator compilers, `schemaErrorFormatter`,
 * `attachValidation` - belong to the app, and the hooks that may rewrite the
 * body - `onSend`, `preSerialization` - are not the route's either: one
 * written in the definition does not compile, and one that gets past the
 * type (a spread, a cast) is thrown on before the route is registered, as is
 * a header in `replyHeaders` outside `REPLY_HEADERS`, by name or by value.
 * The route is registered on the instance behind `registrar`, with a config
 * `isDefinedRoute` knows;
 * an object that `routeRegistrar` did not make is thrown on, and nothing is
 * registered.
 */
export function defineRoute<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
>(
  registrar: RouteRegistrar,
  definition: RouteDefinition<Schema, Responses>,
  handler: RouteHandler<Schema, Responses>,
): void {
  const { method, url, responses, schema, replyHeaders, ...options } =
    definition;
  const instance = instances.get(registrar);
  if (instance === undefined) {
    throw new Error(
      `route ${String(method)} ${url}: not a registrar made by routeRegistrar - a route is registered on the context the app hands over`,
    );
  }
  const refused = Object.entries(REFUSED_OPTIONS)
    .filter(([key]) => Object.hasOwn(options, key))
    .map(([key, reason]) => `${key} (${reason})`);
  if (refused.length > 0) {
    throw new Error(
      `route ${String(method)} ${url}: refused in a route - ${refused.join("; ")}`,
    );
  }
  // Read as what came in, not as the type says: a spread or a cast gets any
  // name and any value - `undefined` among them - past it. Read once: the
  // snapshot is what is checked and what the hook sets, so a getter or a
  // proxy that answers another value on a second read has no second read.
  const given: Readonly<Record<string, unknown>> = { ...replyHeaders };
  const foreign = Object.entries(given)
    .filter(([name, value]) => !allowedHeader(name, value))
    .map(
      ([name, value]) =>
        `${name}: ${typeof value === "string" ? JSON.stringify(value) : typeof value}`,
    );
  if (foreign.length > 0) {
    const allowed = Object.entries(REPLY_HEADERS).map(
      ([name, values]) => `${name}: ${values.join(" | ")}`,
    );
    throw new Error(
      `route ${String(method)} ${url}: reply headers a route does not set (${foreign.join("; ")}) - only ${allowed.join("; ")}`,
    );
  }
  const headers: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(given).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const config: FastifyContextConfig = { ...options.config };
  definedConfigs.add(config);
  const declared: DeclaredSchema<Schema, Responses> = {
    ...schema,
    response: responses,
  };
  instance.route<
    SuccessGeneric<Responses>,
    ContextConfigDefault,
    DeclaredSchema<Schema, Responses>
  >({
    ...options,
    config,
    ...(Object.keys(headers).length === 0
      ? {}
      : {
          onSend: (_request, reply, payload, done) => {
            reply.headers(headers);
            done(null, payload);
          },
        }),
    method,
    url,
    schema: declared,
    handler,
  });
}
