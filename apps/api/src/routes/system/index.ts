import { z } from "zod";
import type { AppInstance } from "../../app.js";
import { BuildInfoSchema, HealthReportSchema } from "../../deps.js";
import type { AppDeps } from "../../deps.js";

/**
 * What the API honestly knows about itself. Queue depth, DLQ size, the
 * heartbeat and the budget spend belong here too, but their shape is written
 * by E0-09 against the real worker - this object is extended there, not
 * guessed at now.
 *
 * `version` and `commit` are nullable: a process that was not told which build
 * it is says so, instead of reporting a made-up version during an incident.
 */
const SystemStatusResponseSchema = z.object({
  build: BuildInfoSchema,
  uptimeSec: z.number().int().nonnegative(),
  checks: HealthReportSchema,
});

export function registerRoutes(app: AppInstance, deps: AppDeps): void {
  app.get(
    "/system/status",
    {
      schema: {
        summary: "Build fingerprint, uptime and dependency checks",
        description: "Requires basic auth.",
        tags: ["system"],
        response: { 200: SystemStatusResponseSchema },
      },
    },
    async () => ({
      build: deps.buildInfo,
      uptimeSec: Math.floor(process.uptime()),
      checks: await deps.health.check(),
    }),
  );
}
