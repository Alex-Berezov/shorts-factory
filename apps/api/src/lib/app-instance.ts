import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

/**
 * The Fastify instance of the service: same as `FastifyInstance`, with the
 * Zod type provider so that `schema.response` types the handler return value.
 * Declared here rather than in `app.ts` so that a module of `src/lib` can name
 * it without importing the app it is part of. A module of `src/routes` does
 * not get one: it is handed a `RouteRegistrar` (`define-route.ts`).
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;
