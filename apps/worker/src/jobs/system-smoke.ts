import { ApiUsageEntrySchema, jobIds } from "@sf/core";
import { z } from "zod";
import { defineJob } from "../lib/define-job.js";

/**
 * The job that proves the pipeline is alive end to end: it goes through Redis,
 * runs in the worker and writes one row into Postgres. It is the acceptance
 * criterion of E0 ("a test job passes the queue and writes to Postgres") and
 * what `pnpm --filter @sf/worker smoke` puts on the queue.
 *
 * It spends nothing, and the row says so: `provider: "system"` is our own
 * bookkeeping, `units: 0`. The row exists because the path a paid job takes -
 * handler, priced call, `ctx.usage`, `api_usage_log` - has to be exercised
 * before there is a paid job to exercise it with.
 */
const SmokePayloadSchema = z
  .object({
    /** When the run was asked for; also the whole of the job id. */
    requestedAtMs: z.number().int().positive(),
  })
  .strict();

export type SmokePayload = z.infer<typeof SmokePayloadSchema>;

export const systemSmokeJob = defineJob({
  queue: "system.smoke",
  payloadSchema: SmokePayloadSchema,
  jobIdFrom: (payload) => jobIds.systemSmoke(payload.requestedAtMs),
  handler: async (payload, ctx) => {
    // Parsed rather than assembled by hand: `ApiUsageEntrySchema` is the
    // contract every priced call answers to, and going through it here means
    // the smoke job breaks first if that contract changes.
    //
    // No `jobId` here: the logger of this run was built with the id of the job
    // (`lib/define-job.ts`) and stamps every row it writes with it. A handler
    // that set it too would be a second place to fix when the stamp changes.
    const entry = ApiUsageEntrySchema.parse({
      provider: "system",
      operation: "smoke",
      units: 0,
    });

    // Through the logger of this run, the same way a paid call reports what it
    // cost: the mapping to the columns, the stamp of the job and the refusal
    // of an entry without a measure all live there, not in the handlers.
    await ctx.usage(entry);

    ctx.log.info(
      { requestedAtMs: payload.requestedAtMs },
      "smoke job wrote a usage row",
    );
  },
});
