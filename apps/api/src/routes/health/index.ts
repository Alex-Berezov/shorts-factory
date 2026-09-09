import { HEALTH_STATUS_CODES, HealthResponseSchema } from "@sf/contracts";
import type { AppInstance } from "../../app.js";
import type { AppDeps } from "../../deps.js";
import {
  type SuccessReply,
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
  // `SuccessReply`.
  app.get<{ Reply: SuccessReply<typeof responses> }>(
    "/health",
    {
      schema: {
        summary: "Liveness of the service and its dependencies",
        description:
          "Public. 200 while Postgres and Redis both answer, 503 otherwise.",
        tags: ["health"],
        response: responses,
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
