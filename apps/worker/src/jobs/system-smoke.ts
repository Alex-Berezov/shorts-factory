import { ApiUsageEntrySchema, jobIds } from "@sf/core";
import { apiUsageLogRepo } from "@sf/db";
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
 * handler, priced call, `api_usage_log` - has to be exercised before there is
 * a paid job to exercise it with (the logger itself arrives in E0-09).
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
    const entry = ApiUsageEntrySchema.parse({
      provider: "system",
      operation: "smoke",
      units: 0,
      ...(ctx.job.id === undefined ? {} : { jobId: ctx.job.id }),
    });

    // `created_at` is left to the database (its own clock stamps the row and
    // ends the aggregation windows), so only the measured fields are written.
    await apiUsageLogRepo.insert(ctx.db, {
      provider: entry.provider,
      operation: entry.operation,
      units: entry.units ?? null,
      jobId: entry.jobId ?? null,
    });

    ctx.log.info(
      { requestedAtMs: payload.requestedAtMs },
      "smoke job wrote a usage row",
    );
  },
});
