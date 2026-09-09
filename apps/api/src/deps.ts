import { z } from "zod";

/**
 * The shapes the routes both return and are typed by, declared once as Zod
 * schemas: the serializer of `/system/status` is generated from them, so a
 * type written separately would let a new probe state pass typecheck and then
 * be rejected on the wire as a 500. They move to `@sf/contracts` in E0-07 as
 * they are.
 */
export const ProbeStatusSchema = z.enum(["up", "down"]);

/** Result of one dependency probe. */
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export const HealthReportSchema = z.object({
  db: ProbeStatusSchema,
  redis: ProbeStatusSchema,
});

/** What `/system/status` reports about the dependencies of this instance. */
export type HealthReport = z.infer<typeof HealthReportSchema>;

/**
 * Liveness of everything the API needs to do its work. An interface rather
 * than the concrete implementation from `lib/health.ts`, so `buildApp` - and
 * with it every route test - stays free of a database handle and a Redis
 * socket.
 */
export interface HealthProbes {
  check(): Promise<HealthReport>;
}

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
 * Everything `buildApp` receives from its caller. Owning connections is
 * `server.ts`'s job: this object only carries what the routes read, which is
 * why `db` and `queues` are not here - E0-09 and E1 add them as narrow
 * interfaces the same way.
 */
export interface AppDeps {
  health: HealthProbes;
  buildInfo: BuildInfo;
}
