import { createHash, timingSafeEqual } from "node:crypto";
import basicAuth from "@fastify/basic-auth";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

/**
 * Routes served without a password. Matched against the declared route url
 * (`/health`), never against the requested url: a comparison against
 * `request.url` would reject `/health?probe=1` and accept anything that merely
 * starts with the same characters.
 *
 * What the caller wrote reaches the same declared url for the spellings a
 * healthcheck and a proxy produce - `/health/` and `//health` - only because
 * `buildApp` builds the instance with `ignoreTrailingSlash` and
 * `ignoreDuplicateSlashes`; without them those two are unknown paths, and an
 * unknown path is answered with 401 here.
 *
 * `/docs`, `/openapi.json` and `/system/*` are deliberately absent - the API
 * is internal, so everything but the liveness probe sits behind the password
 * (decision 2 of the epic).
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(["/health"]);

/** Realm shown by the browser prompt. */
const REALM = "shorts-factory";

/**
 * `@fastify/basic-auth` declares its decorator as a union of the three hook
 * shapes it can be mounted as; all three take the same triple, and this
 * service mounts it as `onRequest`.
 */
type BasicAuthHook = (
  this: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) => void;

/**
 * Constant-time comparison of two secrets of arbitrary length.
 * `timingSafeEqual` throws when the buffers differ in size and would leak the
 * password length through that throw, so both sides are hashed first: the
 * digests are always 32 bytes, and the comparison time no longer depends on
 * how far the guess got.
 */
function secretsMatch(candidate: string, expected: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export interface AuthOptions {
  /** The single admin password of the service (`env.ADMIN_PASSWORD`). */
  password: string;
}

/**
 * Basic auth over the whole API except `PUBLIC_ROUTES`.
 *
 * Registered as a global `onRequest` hook rather than per route: a route
 * added by a later epic is protected the moment it is registered, and
 * publishing one takes an explicit line in `PUBLIC_ROUTES`. The hook is added
 * here, before `/docs` and the route modules are registered, because Fastify
 * binds hooks to routes at registration time - a hook added afterwards would
 * leave the OpenAPI documents open.
 *
 * The user name is not checked and not logged: the service has one secret
 * (docs/DECISIONS.md, 08.09.2026), and the name is arbitrary caller input.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.register(basicAuth, {
    authenticate: { realm: REALM },
    validate(_username, password, _request, _reply, done) {
      if (secretsMatch(password, options.password)) {
        done();
        return;
      }
      done(new Error("Invalid credentials"));
    },
  });

  app.addHook("onRequest", (request, reply, done) => {
    if (
      request.routeOptions.url !== undefined &&
      PUBLIC_ROUTES.has(request.routeOptions.url)
    ) {
      done();
      return;
    }

    const authenticate: BasicAuthHook = app.basicAuth;
    authenticate.call(app, request, reply, done);
  });
}
