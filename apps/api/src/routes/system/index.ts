import type { SystemStatusResponse } from "@sf/contracts";
import { SystemStatusResponseSchema } from "@sf/contracts";
import type { AppInstance } from "../../app.js";
import type { AppDeps } from "../../deps.js";
import {
  OK_STATUS,
  type SuccessReply,
  errorResponses,
} from "../../lib/route-schemas.js";
import { collect, dependencyCheck } from "../../lib/system-status.js";

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
        summary: "Build, uptime, queues, worker liveness and budget spend",
        description:
          "Requires basic auth. Always 200: a section that could not be read is null and `checks` says why.",
        tags: ["system"],
        response: responses,
      },
    },
    async (request): Promise<SystemStatusResponse> => {
      // In parallel: the sections are independent, and one deadline each keeps
      // the page as slow as its slowest dependency rather than their sum.
      const [queues, worker, budget] = await Promise.all([
        collect("queues", () => deps.queues.collect(), request.log),
        collect("worker", () => deps.worker.read(), request.log),
        collect("budget", () => deps.budget.collect(), request.log),
      ]);

      return {
        build: deps.buildInfo,
        uptimeSec: Math.floor(process.uptime()),
        checks: {
          // Read off the sections themselves, with no probe of its own: the
          // sections already talked to both dependencies, and a separate ping
          // would be one more chance for the page to contradict itself - a
          // section that is `null` while its dependency reads as `up`.
          redis: dependencyCheck([queues, worker]),
          db: dependencyCheck([budget]),
        },
        queues: queues.ok ? queues.value.queues : null,
        dlq: queues.ok ? queues.value.dlq : null,
        worker: worker.ok ? worker.value : null,
        budget: budget.ok ? budget.value : null,
      };
    },
  );
}
