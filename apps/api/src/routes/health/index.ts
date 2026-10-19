import { HEALTH_STATUS_CODES, HealthResponseSchema } from "@sf/contracts";
import type { AppInstance } from "../../app.js";
import type { AppDeps } from "../../deps.js";
import {
  defineRoute,
  errorResponses,
  withErrorEnvelope,
} from "../../lib/route-schemas.js";

export function registerRoutes(app: AppInstance, deps: AppDeps): void {
  // 503 rather than 200 with a body to read: a container healthcheck and
  // `depends_on` in Compose (E0-11) branch on the status code alone. Which
  // state travels with which status is `HEALTH_STATUS_CODES` in the contract,
  // so the route and `@sf/api-client` - which has to know that a 503 here is
  // an answer and not a failure - read one object instead of two lists.
  //
  // Both statuses also carry the error envelope, like every other status of
  // every other route: the failures that leave through the error handler with
  // the very same code are serialized against `withErrorEnvelope`, not
  // against the health shape.
  const responses = {
    ...errorResponses(),
    [HEALTH_STATUS_CODES.ok]: HealthResponseSchema,
    [HEALTH_STATUS_CODES.degraded]: withErrorEnvelope(HealthResponseSchema),
  };

  // The reply type is read off the object above rather than written out: see
  // `defineRoute`.
  defineRoute(
    app,
    {
      method: "GET",
      url: "/health",
      responses,
      schema: {
        summary: "Liveness of the service and its dependencies",
        description:
          "Public. 200 while Postgres and Redis both answer, 503 otherwise.",
        tags: ["health"],
      },
      // A verdict about this moment: a proxy or a browser that kept it would
      // answer "up" for a database that has since gone away, or the other way
      // round. On every answer of the route, not only the handler's: the 503
      // of a service that is closing and a 500 leave through the error
      // handler, and a cache with `stale-if-error` would keep serving such a
      // 503 after the service came back. No `bodyLimit` next to it: Fastify
      // 5.12.3 never reads the body of a GET (`bodyless` in `fastify.js:134`,
      // `lib/handle-request.js:35`).
      onSend: (_request, reply, payload, done) => {
        reply.header("cache-control", "no-store");
        done(null, payload);
      },
    },
    async (_request, reply) => {
      const report = await deps.health.check();
      const healthy = report.db === "up" && report.redis === "up";
      const status = healthy ? ("ok" as const) : ("degraded" as const);

      // The status of the answer comes from the same object the responses are
      // declared with, so the code and the word cannot disagree.
      reply.status(HEALTH_STATUS_CODES[status]);
      return { status };
    },
  );
}
