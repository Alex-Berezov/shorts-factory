import type { DependencyCheck, ProbeFailureCode } from "@sf/contracts";
import { errorCode } from "@sf/core";
import { ProbeClosedError, ProbeLimitError } from "@sf/db";
import { DeadlineError, connectionFailure, withDeadline } from "@sf/runtime";
import type { FastifyBaseLogger } from "fastify";
import { DEPENDENCY_TIMEOUT_MS } from "./dependency-timeout.js";

/**
 * How the page is assembled: one deadline per section, a failure of a
 * dependency turned into a reason, and the state of each dependency read back
 * off the sections that used it.
 *
 * Here rather than in the route because none of it is wiring - it is what the
 * response means - and because a route is only reachable through `app.inject`,
 * which leaves the classification below provable by a request only.
 */

/**
 * The codes postgres-js raises as plain `Error`s of its own (`src/errors.js`)
 * when there is no one at the other end. `CONNECT_TIMEOUT` is the connect
 * timeout of the probe handle (`createProbeDb` of `@sf/db`, bounded by its
 * statement timeout); the other three are the server going away with a
 * query in flight - `CONNECTION_CLOSED` is what an ordinary restart or a
 * failover looks like from here, and a page that answered 500 to it would be
 * a page that survives "Postgres is off" and not "Postgres came back".
 *
 * The failures of a socket both drivers share, and the refusals of ioredis
 * while its socket is down, are `connectionFailure` of `@sf/runtime` - the
 * same set the `error` listener of every `Queue` reads.
 */
const POSTGRES_UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
]);

/**
 * The error classes ioredis raises when the server answered and the answer
 * was a refusal. The dependency is reachable and unusable, which is `error` -
 * "the log has the rest of it".
 *
 * The refusal of postgres-js, `PostgresError`, is not here: it is read by its
 * SQLSTATE instead (`postgresFailureCode`), since a server on its way down is
 * `unreachable` and a broken query or a missing grant is a defect of ours
 * rather than a state of the database.
 */
const DRIVER_ERROR_NAMES: ReadonlySet<string> = new Set(["ReplyError"]);

/**
 * SQLSTATEs of a Postgres that is going away or not taking connections, read
 * off the `code` of a `PostgresError` (docs/DECISIONS.md, 11.10.2026, decision R4 of E0-11B).
 *
 * `57P01` admin shutdown, `57P02` crash shutdown, `57P03` cannot connect now
 * (starting up, shutting down, in recovery) and the class `08` (connection
 * exception) but for the states `POSTGRES_REFUSED_STATES` names: the server is
 * answering on its way down or up, and what the operator needs to hear is that
 * Postgres is not there - the same answer as a refused socket, not "it refused
 * the query".
 */
const POSTGRES_UNREACHABLE_STATES: ReadonlySet<string> = new Set([
  "57P01",
  "57P02",
  "57P03",
]);
const POSTGRES_UNREACHABLE_CLASSES: ReadonlySet<string> = new Set(["08"]);

/**
 * SQLSTATEs of a Postgres that is there and turns this service away by its
 * configuration, `refused` (docs/TECH_DEBT.md § E0-12H, п.2, п.3):
 *
 * - the class `28` (invalid authorization specification): a password or a
 *   role that the server no longer accepts;
 * - `57P04` database_dropped and `3D000` invalid_catalog_name: the database
 *   the DSN names is gone or was never created;
 * - `08P01` protocol_violation: the server answered, in a way the driver (or
 *   a proxy in between) did not speak - not a server that is away, which is
 *   why it is named here ahead of the class `08` it belongs to.
 *
 * One reason for all of them: what the operator does next is the same - check
 * the credentials and the DSN in the api log - and the details stay there.
 */
const POSTGRES_REFUSED_STATES: ReadonlySet<string> = new Set([
  "57P04",
  "08P01",
  "3D000",
]);
const POSTGRES_REFUSED_CLASSES: ReadonlySet<string> = new Set(["28"]);

/**
 * SQLSTATEs of a schema that is behind the code, `not_migrated`: `42P01`
 * undefined_table and `42703` undefined_column - the api came up before
 * `migrate` did, or ahead of a migration (docs/TECH_DEBT.md § E0-12H, п.4).
 * Every section that needs the schema fails on its own and the rest of the
 * page is still read. Only these two: the rest of the class `42` - a missing
 * function, a missing grant - is a defect of ours below.
 */
const POSTGRES_NOT_MIGRATED_STATES: ReadonlySet<string> = new Set([
  "42P01",
  "42703",
]);

/**
 * SQLSTATEs of a query the server gave up on: `57014` query_canceled, what a
 * `statement_timeout` or a cancel request ends a query with. Nothing came
 * back in time, which is `timeout` - the same reason the refusal of ioredis
 * after its `commandTimeout` gets (`connectionFailure`, `@sf/runtime`), so one
 * state of a dependency reads the same whichever driver saw it.
 */
const POSTGRES_TIMEOUT_STATES: ReadonlySet<string> = new Set(["57014"]);

/**
 * SQLSTATEs of the class `25` that are a state of the server rather than a
 * statement of ours in the wrong transaction state, `error`:
 *
 * - `25006` read_only_sql_transaction: the session landed on a standby or a
 *   server that is read-only after a failover;
 * - `25P03` idle_in_transaction_session_timeout: the server ended a session
 *   by its own setting;
 * - `25P04` transaction_timeout (Postgres 17): the same, for a transaction
 *   that outlived the `transaction_timeout` of the server.
 *
 * Named ahead of the class `25`, which is a defect of ours otherwise: a 500
 * here would send the operator after a bug in the service while the database
 * is the one that changed.
 */
const POSTGRES_SERVER_STATE_STATES: ReadonlySet<string> = new Set([
  "25006",
  "25P03",
  "25P04",
]);

/**
 * SQLSTATE classes that are a defect of this service rather than a state of
 * Postgres (docs/TECH_DEBT.md § E0-12H, п.1):
 *
 * - `42` a query or a permission that is wrong (a missing function, a missing
 *   grant) but for `POSTGRES_NOT_MIGRATED_STATES`;
 * - `3F` a missing schema;
 * - `22` data the query should never have sent;
 * - `23` a constraint the code should never have broken;
 * - `0A` a feature the server does not support, asked for by our query;
 * - `25` a statement in a transaction state it is not allowed in, but for
 *   `POSTGRES_SERVER_STATE_STATES`;
 * - `26` a prepared statement name that does not exist;
 * - `2B` a dependent object still in the way of a drop;
 * - `34` a cursor name that does not exist;
 * - `2F` a function body that broke its own rules;
 * - `39` a function call protocol broken by the function;
 * - `3B` a savepoint that does not exist;
 * - `44` a row a `WITH CHECK OPTION` view refused.
 *
 * Reported as `db: down` they would send an operator to restart a database
 * that answers every query correctly, which is what the decision of 13.09.2026
 * rules out for every other defect of ours; they leave as a 500 with the
 * request id in the log (decision R4 of E0-11B).
 */
const POSTGRES_DEFECT_CLASSES: ReadonlySet<string> = new Set([
  "42",
  "3F",
  "22",
  "23",
  "0A",
  "25",
  "26",
  "2B",
  "34",
  "2F",
  "39",
  "3B",
  "44",
]);

/**
 * What a `PostgresError` means: a schema behind the code is `not_migrated`, a
 * server that turns us away by its configuration is `refused`, the server
 * going away is `unreachable`, a query it gave up on is `timeout`, a defect of
 * ours is `undefined` (a 500), and any other refusal - too many connections,
 * a lock timeout, a disk that is full - is the server answering badly,
 * `error`. An exact state is read before any class, so a state named on its
 * own wins over the class it belongs to.
 */
function postgresFailureCode(
  code: string | undefined,
): ProbeFailureCode | undefined {
  if (code === undefined) {
    return "error";
  }
  if (POSTGRES_NOT_MIGRATED_STATES.has(code)) {
    return "not_migrated";
  }
  if (POSTGRES_REFUSED_STATES.has(code)) {
    return "refused";
  }
  if (POSTGRES_UNREACHABLE_STATES.has(code)) {
    return "unreachable";
  }
  if (POSTGRES_TIMEOUT_STATES.has(code)) {
    return "timeout";
  }
  if (POSTGRES_SERVER_STATE_STATES.has(code)) {
    return "error";
  }
  const sqlClass = code.slice(0, 2);
  if (POSTGRES_REFUSED_CLASSES.has(sqlClass)) {
    return "refused";
  }
  if (POSTGRES_UNREACHABLE_CLASSES.has(sqlClass)) {
    return "unreachable";
  }
  if (POSTGRES_DEFECT_CLASSES.has(sqlClass)) {
    return undefined;
  }
  return "error";
}

/**
 * Which kind of dependency failure this was, or `undefined` when it was none.
 *
 * The distinction is the point. `timeout`, `unreachable` and the refusals of a
 * driver are states of Postgres or Redis, and the page reports them as such. A
 * `TypeError`, a `ValidationError` from an aggregate asked the wrong question,
 * an answer of a library this service failed to read (`QueueCountersError`) -
 * those are defects of this service, and dressing them as
 * "the database is down" sends an operator to restart Postgres during an
 * incident that has nothing to do with it (decision of 13.09.2026). They are
 * given back to the caller, which answers 500 and puts the error in the log
 * with the request id.
 *
 * `unreachable` is the one an operator acts on differently - the service is
 * not there, as opposed to answering badly. The message itself never reaches
 * the response either way.
 */
export function dependencyFailureCode(
  err: unknown,
): ProbeFailureCode | undefined {
  if (err instanceof DeadlineError) {
    return "timeout";
  }
  // The limit of a probe handle: a caller that joined a stuck read late,
  // under a deadline of its own that had not run out yet, hears the limit
  // first, and so does a call that waited behind it on the connection the
  // limit destroyed. Nothing came back in time either way
  // (docs/TECH_DEBT.md § E0-12H, п.5).
  if (err instanceof ProbeLimitError) {
    return "timeout";
  }
  // A read that came after the stop closed its handle, or that the close left
  // unanswered: the service is going away, not Postgres, and not a defect
  // either - the request lost a race with the stop, and the page says only
  // that the database was not read.
  if (err instanceof ProbeClosedError) {
    return "error";
  }
  const connection = connectionFailure(err);
  if (connection !== undefined) {
    return connection;
  }
  const code = errorCode(err);
  if (code !== undefined && POSTGRES_UNREACHABLE_CODES.has(code)) {
    return "unreachable";
  }
  if (err instanceof Error) {
    if (err.name === "PostgresError") {
      return postgresFailureCode(code);
    }
    if (DRIVER_ERROR_NAMES.has(err.name)) {
      return "error";
    }
  }
  return undefined;
}

/** A section that answered, or the reason it did not. */
export type Collected<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ProbeFailureCode };

/**
 * Runs one collector under the deadline and turns a failure of its dependency
 * into a reason.
 *
 * The deadline is `DEPENDENCY_TIMEOUT_MS`, the bound the probes of `/health`
 * use too: a page about the state of the system has to answer during the
 * incident that made it worth opening, and a dependency that is not there
 * must not hold the request for the driver's own patience.
 *
 * Only a failure of the dependency: anything else is re-thrown and leaves
 * through the error handler as a 500, because a defect of ours reported as
 * `db: down` is a page that lies to the person reading it during an incident.
 *
 * The error itself goes to the log and no further: it comes from a driver, it
 * carries hosts, ports and occasionally credentials, and this response is read
 * by a browser.
 */
export async function collect<T>(
  name: string,
  run: () => Promise<T>,
  log: FastifyBaseLogger,
): Promise<Collected<T>> {
  try {
    return {
      ok: true,
      value: await withDeadline(run, DEPENDENCY_TIMEOUT_MS, { unref: false }),
    };
  } catch (err) {
    const reason = dependencyFailureCode(err);
    if (reason === undefined) {
      throw err;
    }
    log.warn({ err, section: name, reason }, "system status section failed");
    return { ok: false, reason };
  }
}

/**
 * How much a reason says about the dependency, higher being more: the most
 * definite diagnosis wins, not the first collector in the list.
 *
 * `unreachable` is a fact about the socket and `error` an answer of the
 * server; `timeout` only says that nothing came back in time, which either of
 * the other two can look like from a section that gave up first. Two
 * sections of one Redis that failed as `timeout` and `unreachable` are a
 * Redis that is not there, whichever of them is listed first.
 *
 * `not_migrated` and `refused` rank above all three: they name what is wrong
 * with a server that answered, which a socket fact or a deadline seen by
 * another section cannot contradict - the schema is behind or the credentials
 * are turned away whatever the next section ran into
 * (docs/TECH_DEBT.md § E0-12H, п.4).
 */
const REASON_CERTAINTY: Readonly<Record<ProbeFailureCode, number>> = {
  not_migrated: 5,
  refused: 4,
  unreachable: 3,
  error: 2,
  timeout: 1,
};

/**
 * What a dependency looked like to the sections that used it.
 *
 * Derived rather than probed again: one more ping would be one more chance to
 * disagree with the data on the same page, and the reason is a property of the
 * dependency rather than of any one section that failed because of it. The
 * direction that holds by construction is the one the operator needs: a
 * section is `null` only when its dependency is `down`. The opposite pair -
 * `down` next to a section that did answer - is an honest report of a Redis
 * that answered one command and not the other, not a contradiction.
 */
export function dependencyCheck(
  results: ReadonlyArray<Collected<unknown>>,
): DependencyCheck {
  let reason: ProbeFailureCode | undefined;
  for (const result of results) {
    if (
      !result.ok &&
      (reason === undefined ||
        REASON_CERTAINTY[result.reason] > REASON_CERTAINTY[reason])
    ) {
      reason = result.reason;
    }
  }
  return reason === undefined
    ? { status: "up", reason: null }
    : { status: "down", reason };
}
