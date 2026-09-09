import { z } from "zod";

/**
 * The public answer, and all of it. `/health` is the one route without a
 * password, so it says whether the service can work and nothing about how it
 * is built - the version, the commit and the per-dependency breakdown live in
 * `/system/status` (docs/DECISIONS.md, 08.09.2026).
 */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Which status carries which health answer.
 *
 * `/health` answers 503 - not 200 with a body to read - when a dependency is
 * down, because a container healthcheck and `depends_on` in Compose (E0-11)
 * branch on the status code alone. That makes 503 an answer of this route and
 * not only a failure of it, and both ends have to say so: the route declares
 * its responses on these statuses and replies with the code this object gives
 * for the state it reports, and `@sf/api-client` reads the same statuses as
 * answers instead of treating every non-2xx as an error envelope.
 *
 * It lives in the contract because it is the one place both ends already
 * share. Kept apart, the client repeats a number it cannot check, and the
 * next status this route learns to answer with turns a healthy answer into a
 * contract failure on the operator's screen - during the incident that
 * produced it.
 *
 * `satisfies` rather than a plain object: a state added to `HealthResponse`
 * with no status of its own fails to compile here.
 */
export const HEALTH_STATUS_CODES = {
  ok: 200,
  degraded: 503,
} as const satisfies Record<HealthResponse["status"], number>;

/** The statuses of the answers above, for a caller that reads them by code. */
export const HEALTH_ANSWER_STATUSES: readonly number[] =
  Object.values(HEALTH_STATUS_CODES);
