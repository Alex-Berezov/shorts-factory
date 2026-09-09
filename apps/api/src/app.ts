import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
  type RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppDeps } from "./deps.js";
import { REQUEST_ID_HEADER } from "./lib/error-response.js";
import { registerAuth } from "./plugins/auth.js";
import {
  frameworkErrorHandler,
  registerErrorHandler,
} from "./plugins/error-handler.js";
import { registerOpenapi } from "./plugins/openapi.js";
import { registerRoutes } from "./routes/index.js";

export { REQUEST_ID_HEADER };

/**
 * What an incoming correlation id may look like. The header is caller input on
 * a route that needs no password, and its value ends up in every log line of
 * the request, in the response header and in the error body: without a rule an
 * anonymous client can put kilobytes of arbitrary text - or a line break that
 * forges a second log record - into all three. A value that does not match is
 * not an error, it is simply not used: the request gets a generated id.
 */
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * The Fastify instance every route module is written against: same as
 * `FastifyInstance`, with the Zod type provider so that `schema.response`
 * types the handler return value.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildAppOptions {
  /**
   * The single admin password of the service (`env.ADMIN_PASSWORD`).
   * Configuration, not a collaborator, which is why it is not in `AppDeps`;
   * required so that an instance can never come up unprotected.
   */
  adminPassword: string;
  /**
   * Required, with no default: the service passes `buildLoggerOptions(env)`
   * and a test passes `false`. A default of `true` would give pino Fastify's
   * own settings and none of our `redact` paths, so the next caller that
   * forgot the option would quietly log the `authorization` header - the admin
   * password in base64 - the first time something dumps request headers.
   */
  logger: NonNullable<FastifyServerOptions["logger"]>;
}

/**
 * The correlation id the caller asked for, when it is one we are willing to
 * repeat back and write to the log.
 */
function suppliedRequestId(req: IncomingMessage): string | undefined {
  const supplied = req.headers[REQUEST_ID_HEADER];
  return typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : undefined;
}

/**
 * The application without a socket: no `listen`, no connections opened and
 * none closed - `server.ts` owns the lifecycle, and a test gets the same
 * instance through `app.inject`.
 *
 * Registration order is load-bearing. Fastify binds hooks to routes as the
 * routes are registered, and `@fastify/swagger` collects the routes the same
 * way, so both the auth hook and the OpenAPI plugins have to be in place
 * before the first route: reversing it silently publishes `/docs` or ships an
 * empty document.
 */
export function buildApp(deps: AppDeps, options: BuildAppOptions): AppInstance {
  const app = Fastify({
    logger: options.logger,
    // The header is read here rather than through `requestIdHeader`, which
    // takes the value as it comes: a caller that already has a correlation id
    // keeps it if it looks like one, everyone else - and anyone being creative
    // with the header - gets a generated one, so no log line and no error body
    // is without an id and no id is unbounded.
    requestIdHeader: false,
    genReqId: (req) => suppliedRequestId(req) ?? randomUUID(),
    // `/health` is the one route a container healthcheck, a proxy and an
    // operator with curl all call, and they disagree about slashes:
    // `/health/` and `//health` reach the same route as `/health` instead of
    // being an unknown path that basic auth answers with 401 while both
    // dependencies are up. Auth is unaffected: the public list is matched
    // against the declared route url, which is `/health` in every case.
    routerOptions: {
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
    },
    // Without this the router answers its own failures - a url that does not
    // decode, an oversized parameter - with Fastify's payload, before auth,
    // before the hook above and without a log line. The handler lives with
    // the other one, in `plugins/error-handler.ts`.
    frameworkErrors: frameworkErrorHandler,
  }).withTypeProvider<ZodTypeProvider>();

  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });

  registerErrorHandler(app);
  registerAuth(app, { password: options.adminPassword });
  registerOpenapi(app, { version: deps.buildInfo.version });

  // The routes go into a child context registered after the plugins, not
  // straight onto the root instance: `register` defers loading, so
  // `@fastify/swagger` starts collecting routes only once its own
  // registration runs. A route added before that is served but never
  // documented - the document comes out with an empty `paths`.
  app.register(async (instance) => {
    registerRoutes(instance, deps);
  });

  return app;
}
