import { SystemStatusResponseSchema } from "@sf/contracts";
import type { AppInstance } from "../../app.js";
import type { AppDeps } from "../../deps.js";
import {
  OK_STATUS,
  type SuccessReply,
  errorResponses,
} from "../../lib/route-schemas.js";

export function registerRoutes(app: AppInstance, deps: AppDeps): void {
  const responses = {
    ...errorResponses(),
    [OK_STATUS]: SystemStatusResponseSchema,
  };

  // Reply type read off the responses above, for the reason spelled out in
  // `SuccessReply`: the declared failures are responses too, and an inferred
  // reply type would accept an error envelope in place of the status of the
  // service.
  app.get<{ Reply: SuccessReply<typeof responses> }>(
    "/system/status",
    {
      schema: {
        summary: "Build fingerprint, uptime and dependency checks",
        description: "Requires basic auth.",
        tags: ["system"],
        response: responses,
      },
    },
    async () => ({
      build: deps.buildInfo,
      uptimeSec: Math.floor(process.uptime()),
      checks: await deps.health.check(),
    }),
  );
}
