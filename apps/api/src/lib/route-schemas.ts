import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorBodySchema } from "@sf/contracts";
import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifySchema,
  HTTPMethods,
  RawServerDefault,
  RouteHandlerMethod,
  RouteShorthandOptions,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppInstance } from "../app.js";

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

/**
 * The options of a route the error envelope rests on: they belong to the app.
 * `RouteExtras` leaves them out, so a literal that passes one does not
 * compile, and `defineRoute` throws on one that comes in past the type (a
 * spread, a cast).
 */
const APP_OPTIONS = [
  "errorHandler",
  "serializerCompiler",
  "validatorCompiler",
  "schemaErrorFormatter",
  "attachValidation",
] as const;

/**
 * The options Fastify takes for the route, typed with the same generic and
 * schema as the handler: the hooks (`onSend` of `/health`), `bodyLimit`,
 * `config` and the rest, without `schema`, which `defineRoute` assembles,
 * and without `APP_OPTIONS`.
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
  "schema" | (typeof APP_OPTIONS)[number]
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
 * `attachValidation` - belong to the app: one written in the definition does
 * not compile, and one that gets past the type (a spread, a cast) is thrown
 * on before the route is registered. A module of `src/routes` calls nothing
 * else on the instance to register a route: the rule S13 of
 * `.claude/hooks/rules.sf.json` refuses `.get(`, `.route(` and
 * `withTypeProvider` there.
 */
export function defineRoute<
  Schema extends RouteSchema,
  Responses extends RouteResponses,
>(
  app: AppInstance,
  definition: RouteDefinition<Schema, Responses>,
  handler: RouteHandler<Schema, Responses>,
): void {
  const { method, url, responses, schema, ...options } = definition;
  const taken = APP_OPTIONS.filter((key) => Object.hasOwn(options, key));
  if (taken.length > 0) {
    throw new Error(
      `route ${String(method)} ${url}: options of the app in a route (${taken.join(", ")}) - the error envelope rests on them`,
    );
  }
  const declared: DeclaredSchema<Schema, Responses> = {
    ...schema,
    response: responses,
  };
  app.route<
    SuccessGeneric<Responses>,
    ContextConfigDefault,
    DeclaredSchema<Schema, Responses>
  >({
    ...options,
    method,
    url,
    schema: declared,
    handler,
  });
}
