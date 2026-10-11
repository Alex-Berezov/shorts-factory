import type { FastifyInstance } from "fastify";
import { ServiceClosingError } from "../lib/error-mapping.js";

/**
 * Load shedding during the stop, as Fastify's `return503OnClosing` does it
 * but through the error handler: a request routed while the service is
 * closing is answered with `ServiceClosingError`, a 503 in the envelope of
 * every other response. `buildApp` turns Fastify's own off - it is written
 * straight to the socket in `lib/route.js:480-502`, in its own shape and
 * without the request id.
 *
 * The flag is set by the first `preClose` hook: in Fastify 5.12.3 the close
 * sequence is an `onClose` of its own, registered on `preReady`
 * (`fastify.js:384-389`), which sets its `closing` state, calls
 * `router.closeRoutes()` and then runs `preClose`. No public hook runs
 * earlier - a root `onClose` runs after that one, past `server.close()` - and
 * `preClose` follows `closeRoutes` within the same turn of the event loop, so
 * no request is routed between the two (checked by a run, decision R-a of
 * E0-11B as refined by its question 2, docs/DECISIONS.md 11.10.2026).
 *
 * Registered before auth: a stop is not a reason to tell a caller its
 * password is wrong. `Connection: close` is Fastify's (`lib/route.js:482`),
 * set for every request routed while closing.
 */
export function registerClosing(app: FastifyInstance): void {
  let closing = false;
  app.addHook("preClose", (done) => {
    closing = true;
    done();
  });
  app.addHook("onRequest", (_request, _reply, done) => {
    if (closing) {
      done(new ServiceClosingError());
      return;
    }
    done();
  });
}
