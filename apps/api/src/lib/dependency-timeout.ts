import type { ProbeDbOptions } from "@sf/db";

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
 * its `commandTimeout`, a database query by the `statement_timeout` of its
 * session (this same number) or, on a socket that cannot answer, by
 * `PROBE_QUERY_LIMIT_MS` below, and the pile-up of both is bounded by
 * `singleFlight` (`lib/single-flight.ts`).
 */
export const DEPENDENCY_TIMEOUT_MS = 2_000;

/**
 * How long one call of a probe may live on its connection - the db probe of
 * `/health` and the read of the `budget` section - before the connection is
 * ended (the call is released, the socket is closed with a FIN; a half-open one
 * lives on until the OS timeout) and the next call goes over a new one (`createProbeDb` of
 * `@sf/db`; docs/TECH_DEBT.md § E0-12H, п.5).
 *
 * It is the bound for a socket that cannot answer - the half-open one, where
 * nothing the server does reaches the api. A server that is there and slow is
 * bounded first, and more cheaply, by the `statement_timeout` of the session,
 * which is `DEPENDENCY_TIMEOUT_MS` (`PROBE_DB_BOUNDS`): it ends the query
 * with `57014`, the reason is `timeout`, and the connection lives on. That
 * holds because every call of a probe is one statement - the ping, and the
 * read of every cap in one `select` (`countBudgetChecks`): the server bounds
 * a statement and the limit a call, so a call of several statements would
 * let a slow server outlive the limit. The handle sends no type fetch of the
 * driver on a new connection (`fetch_types: false`), which would be a second
 * statement in front of the first call. A host that never answers the
 * connect is bounded by the same number (`connect_timeout` of the handle): it is
 * `CONNECT_TIMEOUT` - a property of the handle of `@sf/db`, not of the page.
 * The deadline of a section is this same `DEPENDENCY_TIMEOUT_MS` and is armed
 * before the connect starts, so on such a host the page sees its own deadline
 * first and reads `db: down (timeout)`, not `unreachable`. What the connect bound gives the api is that nothing is
 * ended: the connect is refused before the limit, the client lives on,
 * no warning of the limit is written and the next poll goes over the same
 * client (`test/system-status.int.test.ts`).
 *
 * The limit is twice the statement timeout and derived from it, so the two
 * cannot drift apart. On a connection that is already open the server gets to
 * answer first; on a fresh client the connect comes first, and a connect and
 * a statement each at their bound use up the limit with nothing to spare - a
 * database that slow is treated as a silent one. A limit at or under the
 * statement timeout would take down the connection of every honest slow
 * answer (`createProbeDb` refuses it), a limit far longer would let a
 * half-open socket keep `/health` at 503 after Postgres is back. Four seconds
 * is well inside one interval of the pollers - the api healthcheck every 15 s
 * (`infra/docker-compose.app.yml`) and the revalidate of 15 s of the web page
 * (L-023) - so the next poll after a stuck call always goes over a fresh
 * connection.
 */
export const PROBE_QUERY_LIMIT_MS = 2 * DEPENDENCY_TIMEOUT_MS;

/**
 * The bounds every probe handle of the api is opened with (`createProbeDb`):
 * the server ends a slow query at `DEPENDENCY_TIMEOUT_MS`, the handle gives
 * up on a socket that cannot answer at `PROBE_QUERY_LIMIT_MS`. One object, so
 * the composition and the tests that open a handle of their own cannot pair
 * the two differently.
 */
export const PROBE_DB_BOUNDS: Readonly<
  Pick<ProbeDbOptions, "limitMs" | "statementTimeoutMs">
> = {
  limitMs: PROBE_QUERY_LIMIT_MS,
  statementTimeoutMs: DEPENDENCY_TIMEOUT_MS,
};
