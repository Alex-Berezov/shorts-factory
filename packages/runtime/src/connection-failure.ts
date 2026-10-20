import { errorCode } from "@sf/core";

/**
 * Which failures mean "the dependency is not there" rather than "it answered
 * badly" - one set, read by the status page of the api (`system-status.ts`,
 * which adds the codes of postgres-js and the classes of a refusal) and by the
 * `error` listener of every `Queue` (`queues.ts`), so that the two cannot
 * disagree about the same ioredis error.
 */

/**
 * Error codes of a socket with no one at the other end, the same for every
 * driver.
 *
 * Read off `err.code`, never off the message: the wording belongs to the
 * driver and changes with it, and a match on free text is how the host, the
 * port and occasionally the credentials in that text end up being treated as
 * a classification.
 */
const SOCKET_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  // A resolver that did not answer: the name of the service inside Docker
  // while its DNS is not up yet - nobody there, as far as this process knows.
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * The verbatim message ioredis rejects a command with once the
 * `commandTimeout` of the client ran out: the socket is open and nothing came
 * back in time. A plain `Error` without a `code` (`built/Command.js`), so the
 * message is all there is to recognise it by.
 */
const REDIS_COMMAND_TIMEOUT_MESSAGE = "Command timed out";

/**
 * Verbatim messages of the ioredis refusals that mean "the socket is down":
 * plain `Error`s with no `code`, compared as whole constant strings - never a
 * pattern over a message that may carry a host.
 */
const REDIS_DOWN_MESSAGES: ReadonlySet<string> = new Set([
  "Connection is closed.",
  "Stream isn't writeable and enableOfflineQueue options is false",
]);

/**
 * Failures recognised by class rather than by code. `MaxRetriesPerRequestError`
 * is ioredis flushing the command queue because the socket is dead and the
 * retry budget of the client is spent (`event_handler.js`). It carries no
 * `code`, and it is the opposite of a server that answered.
 */
const UNREACHABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MaxRetriesPerRequestError",
]);

/** How a connection failed: nobody there, or nobody answering in time. */
type ConnectionFailure = "unreachable" | "timeout";

/**
 * Whether `err` is a failure of the connection itself, and which: a socket
 * with no one at the other end (`unreachable`) or a command the client gave
 * up waiting for (`timeout`). Anything else - a refusal of the server, a
 * defect of ours - is `undefined`.
 */
export function connectionFailure(err: unknown): ConnectionFailure | undefined {
  const code = errorCode(err);
  if (code !== undefined && SOCKET_FAILURE_CODES.has(code)) {
    return "unreachable";
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  if (err.message === REDIS_COMMAND_TIMEOUT_MESSAGE) {
    return "timeout";
  }
  if (
    REDIS_DOWN_MESSAGES.has(err.message) ||
    UNREACHABLE_ERROR_NAMES.has(err.name)
  ) {
    return "unreachable";
  }
  return undefined;
}
