/**
 * The shared bound of every dependency call the api makes on behalf of a
 * request: the probes of `/health` (`lib/health.ts`), the sections of
 * `/system/status` (`lib/system-status.ts`) and the `commandTimeout` of the
 * Redis client (`compose-app.ts`).
 *
 * One number for all of them, because they answer the same question - is the
 * dependency there - and two constants of one threshold drift apart on the
 * first edit. It sits well under the `timeout: 5s` of the api healthcheck in
 * `infra/docker-compose.app.yml`, so a dependency that is down shows up as a
 * 503 the healthcheck reads rather than as a healthcheck that timed out.
 *
 * The deadline itself is `withDeadline` of `@sf/runtime`, with a live timer:
 * it bounds a request, and a request is what keeps the process busy. It does
 * not cancel the call it gives up on - the Redis client ends such a command by
 * its `commandTimeout`, a database query has no such bound, and the pile-up of
 * both is bounded by `singleFlight` (`lib/single-flight.ts`). Cancelling the
 * database probe is E0-12H.
 */
export const DEPENDENCY_TIMEOUT_MS = 2_000;
