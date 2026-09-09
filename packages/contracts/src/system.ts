import { z } from "zod";

/**
 * The shapes `/system/status` is built from, and the types api and web use for
 * them: `z.infer` of the schema on this page, never a type written out beside
 * it. The schema is what the response is serialized against, so a type written
 * separately is a second declaration that nothing compares to the first - a
 * new probe state, or a field spelled differently, passes typecheck and is
 * then rejected on the wire as a 500. The same rule holds on the other side of
 * the boundary: `apps/api` reads the reply type of a route off the schema it
 * declared (`apps/api/src/lib/route-schemas.ts`, `SuccessReply`).
 */

/** Result of one dependency probe. */
export const ProbeStatusSchema = z.enum(["up", "down"]);

export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

/** What `/system/status` reports about the dependencies of an instance. */
export const HealthReportSchema = z.object({
  db: ProbeStatusSchema,
  redis: ProbeStatusSchema,
});

export type HealthReport = z.infer<typeof HealthReportSchema>;

/**
 * Fingerprint of the running build. Both fields are `null` when the process
 * was not told what it is: an invented `"0.0.0"` would be indistinguishable
 * from a real version in an incident.
 */
export const BuildInfoSchema = z.object({
  version: z.string().nullable(),
  commit: z.string().nullable(),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

/**
 * What the API honestly knows about itself. Queue depth, DLQ size, the
 * heartbeat and the budget spend belong here too, but their shape is written
 * by E0-09 against the real worker - this object is extended there, not
 * guessed at now.
 */
export const SystemStatusResponseSchema = z.object({
  build: BuildInfoSchema,
  uptimeSec: z.number().int().nonnegative(),
  checks: HealthReportSchema,
});

export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;
