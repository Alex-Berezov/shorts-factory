import {
  BUDGET_MEASURES,
  BUDGET_PERIODS,
  BUDGET_SCOPE_KEYS,
  QUEUE_NAMES,
} from "@sf/core";
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

/** What the probes behind `/health` report about the dependencies. */
export const HealthReportSchema = z.object({
  db: ProbeStatusSchema,
  redis: ProbeStatusSchema,
});

export type HealthReport = z.infer<typeof HealthReportSchema>;

/**
 * Why a dependency did not answer, as a closed set rather than a message.
 *
 * A message from an external system is not a contract: it changes with the
 * driver, and it carries hosts, ports and occasionally credentials into a
 * response body and onto a dashboard. These three are what an operator acts
 * on differently - a deadline of ours, a socket that is not there, and
 * anything else, which means "read the log".
 */
export const ProbeFailureCodeSchema = z.enum([
  "timeout",
  "unreachable",
  "error",
]);

export type ProbeFailureCode = z.infer<typeof ProbeFailureCodeSchema>;

/**
 * One dependency as `/system/status` reports it.
 *
 * Flat, with the invariant "up means no reason": a discriminated union would
 * serialize as `anyOf` for a pair of fields, and the reason belongs to the
 * dependency rather than to any one section that failed because of it.
 *
 * The invariant is a rule of this schema rather than a sentence about it: a
 * `{ status: "up", reason: "timeout" }` that parsed would be drawn by E0-10 as
 * a dependency that is alive with the reason it is not, and the pair is built
 * on this side of the wire, so a reader that finds them together is reading a
 * body nobody should have been able to produce. The refinement only narrows
 * what parses - the serialized shape stays the flat object above, because a
 * refinement has no JSON Schema of its own.
 */
export const DependencyCheckSchema = z
  .object({
    status: ProbeStatusSchema,
    reason: ProbeFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.status === "up" && check.reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "a dependency that is up has no reason",
      });
    }
    if (check.status === "down" && check.reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "a dependency that is down has to say why",
      });
    }
  });

export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/**
 * The dependencies of the instance, as the sections of this response found
 * them. Nothing here is probed separately: a `redis` that is `up` while the
 * queue counters are missing would be a state nobody can act on.
 */
export const SystemChecksSchema = z
  .object({
    db: DependencyCheckSchema,
    redis: DependencyCheckSchema,
  })
  .strict();

export type SystemChecks = z.infer<typeof SystemChecksSchema>;

/**
 * One queue of the registry.
 *
 * `paused` is a flag of the queue, not a count of a list: BullMQ renames the
 * `wait` list to `paused` while a queue is paused, so a paused queue reports
 * its backlog there and its `waiting` count would read as zero - "nothing to
 * do" instead of "nobody is taking it". `waiting` below is therefore both
 * lists together, and `paused` answers the other question on its own.
 *
 * An array with the name inside each row rather than a map of 29 dynamic keys:
 * E13-02 adds fields to a row, and a record of that shape cannot be described
 * to the serializer without leaving it open.
 */
export const QueueStatusSchema = z
  .object({
    name: z.enum(QUEUE_NAMES),
    /** Jobs waiting to be taken, including the ones held by a pause. */
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    paused: z.boolean(),
  })
  .strict();

export type QueueStatus = z.infer<typeof QueueStatusSchema>;

/** How much is waiting in the dead letter queue for an operator to look at. */
export const DlqStatusSchema = z
  .object({ size: z.number().int().nonnegative() })
  .strict();

export type DlqStatus = z.infer<typeof DlqStatusSchema>;

/**
 * Liveness of the worker as the api sees it: the stamp it left and whether
 * that stamp is old enough to mean the worker is gone. A missing stamp is
 * `null` with `stale: true` - the key expires on its own, so "nobody wrote it"
 * and "the worker is down" are the same answer.
 */
export const WorkerStatusSchema = z
  .object({
    heartbeatAt: z.string().nullable(),
    stale: z.boolean(),
  })
  .strict();

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

/**
 * One cap and where it stands: quota units for the day, dollars for the day,
 * dollars for the month. `ratio` is reported unrounded and `warn` is not
 * derived from it by the reader - both come from the guard that decides
 * whether a call may happen at all.
 */
export const BudgetStatusSchema = z
  .object({
    // All three out of `@sf/core`, never spelled again here: a cap the domain
    // learns about has to reach the wire or be refused at the source, not be
    // accepted by the guard and then rejected by the serializer of the route.
    key: z.enum(BUDGET_SCOPE_KEYS),
    measure: z.enum(BUDGET_MEASURES),
    period: z.enum(BUDGET_PERIODS),
    /**
     * IANA zone the period is cut in - the YouTube day ends at midnight
     * Pacific, the money periods end in UTC. On the wire because the operator
     * reading "spent today" has to be told whose today it is (E0-10), and
     * because a cap that silently changed zone would otherwise look like a
     * counter that reset for no reason.
     */
    timeZone: z.string().min(1),
    spent: z.number().nonnegative(),
    cap: z.number().positive(),
    ratio: z.number().nonnegative(),
    warn: z.boolean(),
    exceeded: z.boolean(),
  })
  .strict();

export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

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
 * What the API honestly knows about itself and about the pipeline behind it.
 *
 * The page an operator opens during an incident, so every section that cannot
 * be read is `null` and the reason is in `checks` - never a zero. "The queue
 * is empty" and "Redis is unreachable" have to be different things on the
 * screen, and a 503 for the whole response would leave the sections that are
 * readable unread. The status code stays 200 (docs/DECISIONS.md, 08.09.2026):
 * `/health` is the route that answers a healthcheck with a code.
 */
export const SystemStatusResponseSchema = z
  .object({
    build: BuildInfoSchema,
    uptimeSec: z.number().int().nonnegative(),
    checks: SystemChecksSchema,
    /** Every queue of the registry, in registry order; `null` if unreadable. */
    queues: z.array(QueueStatusSchema).nullable(),
    dlq: DlqStatusSchema.nullable(),
    worker: WorkerStatusSchema.nullable(),
    /** The caps, in the order the guard reports them. */
    budget: z.array(BudgetStatusSchema).nullable(),
  })
  .strict();

export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;
