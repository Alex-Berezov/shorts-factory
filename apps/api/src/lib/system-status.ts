import type { DependencyCheck, ProbeFailureCode } from "@sf/contracts";
import type { FastifyBaseLogger } from "fastify";
import {
  DEPENDENCY_TIMEOUT_MS,
  DeadlineError,
  withDeadline,
} from "./deadline.js";

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
 * Error codes both drivers use for "there is no one at the other end".
 *
 * Read off `err.code`, never off the message: the wording belongs to the
 * driver and changes with it, and a match on free text is how the host, the
 * port and occasionally the credentials in that text end up being treated as
 * a classification.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // postgres-js, `src/errors.js`: the four it raises as plain `Error`s with a
  // `code` of their own. `CONNECT_TIMEOUT` is the connect timeout of
  // `createDb`; the other three are the server going away with a query in
  // flight - `CONNECTION_CLOSED` is what an ordinary restart or a failover
  // looks like from here, and a page that answered 500 to it would be a page
  // that survives "Postgres is off" and not "Postgres came back".
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
]);

/**
 * The verbatim message ioredis rejects a command with once the
 * `commandTimeout` of the client (`lib/redis.ts`) ran out: the socket is open
 * and nothing came back in time, which is what `timeout` says. A plain
 * `Error` without a `code` (`built/Command.js`), so the message is all there
 * is to recognise it by.
 */
const REDIS_COMMAND_TIMEOUT_MESSAGE = "Command timed out";

/** Verbatim messages of the ioredis refusals that mean "the socket is down". */
const REDIS_DOWN_MESSAGES: ReadonlySet<string> = new Set([
  "Connection is closed.",
  "Stream isn't writeable and enableOfflineQueue options is false",
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
 * (starting up, shutting down, in recovery) and the whole class `08`
 * (connection exception): the server is answering on its way down or up, and
 * what the operator needs to hear is that Postgres is not there - the same
 * answer as a refused socket, not "it refused the query".
 */
const POSTGRES_UNREACHABLE_STATES: ReadonlySet<string> = new Set([
  "57P01",
  "57P02",
  "57P03",
]);
const POSTGRES_UNREACHABLE_CLASSES: ReadonlySet<string> = new Set(["08"]);

/**
 * SQLSTATEs of a query the server gave up on: `57014` query_canceled, what a
 * `statement_timeout` or a cancel request ends a query with. Nothing came
 * back in time, which is `timeout` - the same reason the refusal of ioredis
 * after its `commandTimeout` gets (`REDIS_COMMAND_TIMEOUT_MESSAGE`), so one
 * state of a dependency reads the same whichever driver saw it.
 */
const POSTGRES_TIMEOUT_STATES: ReadonlySet<string> = new Set(["57014"]);

/**
 * SQLSTATE classes that are a defect of this service rather than a state of
 * Postgres: `42` a query or a permission that is wrong (a missing table, a
 * missing grant), `3F` a missing schema, `22` data the query should never have
 * sent, `23` a constraint the code should never have broken.
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
]);

/**
 * What a `PostgresError` means, by the class of its SQLSTATE: the server going
 * away is `unreachable`, a query it gave up on is `timeout`, a defect of ours
 * is `undefined` (a 500), and any other refusal - too many connections, a
 * lock timeout, a disk that is full - is the server answering badly, `error`.
 */
function postgresFailureCode(
  code: string | undefined,
): ProbeFailureCode | undefined {
  if (code !== undefined) {
    const sqlClass = code.slice(0, 2);
    if (
      POSTGRES_UNREACHABLE_STATES.has(code) ||
      POSTGRES_UNREACHABLE_CLASSES.has(sqlClass)
    ) {
      return "unreachable";
    }
    if (POSTGRES_TIMEOUT_STATES.has(code)) {
      return "timeout";
    }
    if (POSTGRES_DEFECT_CLASSES.has(sqlClass)) {
      return undefined;
    }
  }
  return "error";
}

/**
 * Failures recognised by class rather than by code, and meaning "there is no
 * one at the other end" all the same.
 *
 * `MaxRetriesPerRequestError` is ioredis flushing the command queue because
 * the socket is dead and the retry budget of this client is spent
 * (`event_handler.js`, `maxRetriesPerRequest: 1` in `lib/redis.ts`). It
 * carries no `code`, and it is the opposite of a server that answered: an
 * operator told `error` would go looking in the log for a Redis that is simply
 * not running.
 */
const UNREACHABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MaxRetriesPerRequestError",
]);

/** The `code` an error carries, when it carries one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === "string" ? code : undefined;
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
  const code = errorCode(err);
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return "unreachable";
  }
  if (err instanceof Error) {
    if (err.message === REDIS_COMMAND_TIMEOUT_MESSAGE) {
      return "timeout";
    }
    // The two refusals ioredis raises while the socket is down and the offline
    // queue is off. They arrive as plain `Error`s with no `code`, so there is
    // nothing else to recognise them by; the comparison is against the whole
    // constant string, never a pattern over a message that may carry a host.
    if (REDIS_DOWN_MESSAGES.has(err.message)) {
      return "unreachable";
    }
    if (UNREACHABLE_ERROR_NAMES.has(err.name)) {
      return "unreachable";
    }
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
    return { ok: true, value: await withDeadline(run, DEPENDENCY_TIMEOUT_MS) };
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
 */
const REASON_CERTAINTY: Readonly<Record<ProbeFailureCode, number>> = {
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
