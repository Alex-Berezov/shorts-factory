import { z } from "zod";
import type { AppInstance } from "../../app.js";
import type { AppDeps } from "../../deps.js";

/**
 * The public answer, and all of it. `/health` is the one route without a
 * password, so it says whether the service can work and nothing about how it
 * is built - the version, the commit and the per-dependency breakdown live in
 * `/system/status` (docs/DECISIONS.md, 08.09.2026).
 */
const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
});

export function registerRoutes(app: AppInstance, deps: AppDeps): void {
  app.get(
    "/health",
    {
      schema: {
        summary: "Liveness of the service and its dependencies",
        description:
          "Public. 200 while Postgres and Redis both answer, 503 otherwise.",
        tags: ["health"],
        // 503 rather than 200 with a body to read: a container healthcheck and
        // `depends_on` in Compose (E0-11) branch on the status code alone.
        response: { 200: HealthResponseSchema, 503: HealthResponseSchema },
      },
    },
    async (_request, reply) => {
      const report = await deps.health.check();
      const healthy = report.db === "up" && report.redis === "up";

      reply.status(healthy ? 200 : 503);
      return { status: healthy ? ("ok" as const) : ("degraded" as const) };
    },
  );
}
