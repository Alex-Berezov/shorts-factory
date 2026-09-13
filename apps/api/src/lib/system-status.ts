import type { DependencyCheck, ProbeFailureCode } from "@sf/contracts";
import type { FastifyBaseLogger } from "fastify";
import { DeadlineError, withDeadline } from "./deadline.js";

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
 * How long one section is given to answer. The same bound as the probes of
 * `/health` (`lib/health.ts`): a page about the state of the system has to
 * answer during the incident that made it worth opening, and a dependency that
 * is not there must not hold the request for the driver's own patience.
 */
const STATUS_TIMEOUT_MS = 2_000;

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

/** Verbatim messages of the ioredis refusals that mean "the socket is down". */
const REDIS_DOWN_MESSAGES: ReadonlySet<string> = new Set([
  "Connection is closed.",
  "Stream isn't writeable and enableOfflineQueue options is false",
]);

/**
 * The error classes the two drivers raise when the server answered and the
 * answer was a refusal: a bad command, a permission, a broken query. The
 * dependency is reachable and unusable, which is `error` - "the log has the
 * rest of it".
 */
const DRIVER_ERROR_NAMES: ReadonlySet<string> = new Set([
  // ioredis
  "ReplyError",
  // postgres-js
  "PostgresError",
]);

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
    return { ok: true, value: await withDeadline(run, STATUS_TIMEOUT_MS) };
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
  const failure = results.find((result) => !result.ok);
  return failure === undefined || failure.ok
    ? { status: "up", reason: null }
    : { status: "down", reason: failure.reason };
}
