import { ErrorBodySchema } from "@sf/contracts";
import { z } from "zod";

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
 * is built from - `SuccessReply<typeof responses>`, not a type name written
 * out a second time next to it. There is then one declaration and no pair to
 * drift apart: the schema at `OK_STATUS` decides both what is serialized and
 * what the handler is allowed to return, and a route whose responses have no
 * `OK_STATUS` key does not compile.
 *
 * What this does not do is check the other statuses: a body returned with
 * `reply.status(503).send(...)` is outside the reply type, and nothing but
 * the serializer reads the schema declared there.
 */
export type SuccessReply<
  Responses extends Record<typeof OK_STATUS, z.ZodTypeAny>,
> = z.infer<Responses[typeof OK_STATUS]>;

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
