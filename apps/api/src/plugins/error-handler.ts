import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { REQUEST_ID_HEADER } from "@sf/contracts";
import type {
  ConnectionError,
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  clientError,
  mapError,
  mapFrameworkError,
} from "../lib/error-mapping.js";
import { errorBodyOf } from "../lib/error-response.js";
import { logError, logRejection } from "../lib/request-log.js";
import { mapSocketError } from "../lib/socket-errors.js";

/** Status of the route nobody declared, shared by the two handlers below. */
const NOT_FOUND_STATUS = 404;

/**
 * The router's own answer, in the shape of every other failure of this API.
 *
 * Without it Fastify replies to a malformed url itself, and that reply is
 * outside everything this file and `buildApp` set up: Fastify's payload shape
 * instead of ours, no `requestId`, no `x-request-id` header, no basic auth in
 * front of it and no line in the log - an anonymous caller gets back its own
 * url and the name of the framework, and a run of malformed requests leaves no
 * trace.
 *
 * The request and the reply here are built by the router on the server-wide
 * context (`fastify.js`, `onBadUrl`), not on a route, so the `onSend` hook of
 * `buildApp` never runs for this reply: the correlation header is set by hand.
 */
export function frameworkErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const mapped = mapFrameworkError(err);
  logError(request, err, mapped);

  reply
    .header(REQUEST_ID_HEADER, request.id)
    .status(mapped.status)
    .send(errorBodyOf(mapped, request.id));
}

/** Network-level reset: the peer is gone and there is nobody to answer. */
const CONNECTION_RESET = "ECONNRESET";

/** Separator of the lines of a raw HTTP/1.1 response. */
const HTTP_LINE_BREAK = "\r\n";

/**
 * The part of the socket the answer to a refused request uses; `Socket` is
 * one, and a test can be another.
 */
export interface RefusedSocket {
  readonly destroyed: boolean;
  readonly writable: boolean;
  end(data: string, callback: () => void): unknown;
  destroy(error?: Error): unknown;
}

/**
 * The sockets this handler has answered and not yet closed. Node keeps reading
 * a socket whose request it refused - the rest of an oversized header arrives
 * in the next chunks - and every chunk the failed parser is handed raises
 * `clientError` again. The response is already on its way then: a second line
 * in the log would count one request twice (Д1 E0-11A), and the `destroy` the
 * now unwritable socket would get throws the response away before it is
 * flushed. The reading itself goes on: the socket is not paused and its
 * listeners stay. That does not save the response from a long request - a tail
 * still unread when the socket is closed makes the system answer with a reset,
 * as it does under Node's own fallback handler, and a client that gets one can
 * lose the response it had not read yet. Draining the tail with a deadline
 * before the close is E13-07.
 */
const answering = new WeakSet<RefusedSocket>();

/**
 * Whether a response to an earlier request on this connection has started
 * going out. Node keeps the response in flight on the socket (`_httpMessage`,
 * an internal field `socketOnError` in `_http_server.js` reads the same way)
 * and drops it once the response is finished: on a keep-alive connection
 * between two requests there is none, and the socket is free to answer.
 */
function responseInFlight(socket: RefusedSocket): boolean {
  const message: unknown = Reflect.get(socket, "_httpMessage");
  return (
    typeof message === "object" &&
    message !== null &&
    "headersSent" in message &&
    message.headersSent === true
  );
}

/**
 * The answer to a request Node refused while parsing it - headers over the
 * size limit (431), a request that took too long to arrive (408), bytes that
 * are not HTTP (400) - in the shape of every other failure of this API.
 *
 * Without it Fastify's `defaultClientErrorHandler` answers these: its own
 * payload, no `requestId`, no `x-request-id` and a log line at `trace`, so a
 * client meets a body it cannot parse and a run of broken requests on the
 * published port leaves nothing behind. There is no request and no reply
 * here, only the socket: the response is written by hand, with a generated
 * id in the body and in the header, and the connection is closed after it.
 *
 * The socket checks follow Node's own fallback (`_http_server.js`,
 * `socketOnError`): after a reset or on a destroyed socket there is nobody to
 * answer; a socket already being answered is left to that answer
 * (`answering`); a socket that is no longer writable, or that is already carrying a
 * response to an earlier request, is closed without a word - bytes after a
 * half-sent response would be read as part of it, and a write after the end
 * throws `ERR_STREAM_WRITE_AFTER_END` out of an event handler, which takes the
 * process down. A keep-alive connection that has answered requests before is
 * answered like a fresh one.
 *
 * The response goes out with `end`, and the socket is destroyed only once it
 * is flushed: destroying it right after `write` throws away whatever the
 * socket had not handed to the system yet. Flushed is not read, though: a
 * tail of the request still unread at the close makes the system answer with
 * a reset, as under Node's own fallback handler, and the client can see a
 * dropped connection instead of the envelope (draining with a deadline -
 * E13-07).
 *
 * Logged like every other failure before the password (`logRejection`):
 * `info`, no error object, nothing of what was sent. A socket closed without
 * a word still gets its line, with the `status` the request would have been
 * answered with - but without a `requestId`: an id nobody will ever see in a
 * response is a false lead for whoever searches the log by it. The id is
 * generated only for a response that is really written, and that line and
 * the response carry the same one.
 */
export function answerClientError(
  err: ConnectionError,
  socket: RefusedSocket,
  log: FastifyBaseLogger,
): void {
  if (
    err.code === CONNECTION_RESET ||
    socket.destroyed ||
    answering.has(socket)
  ) {
    return;
  }

  const mapped = mapSocketError(err.code);
  if (!socket.writable || responseInFlight(socket)) {
    log.info({ status: mapped.status, code: mapped.code }, "request rejected");
    socket.destroy(err);
    return;
  }

  const requestId = randomUUID();
  log.info(
    { status: mapped.status, code: mapped.code, requestId },
    "request rejected",
  );

  const body = JSON.stringify(errorBodyOf(mapped, requestId));
  answering.add(socket);
  socket.end(
    [
      `HTTP/1.1 ${mapped.status} ${mapped.message}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      `${REQUEST_ID_HEADER}: ${requestId}`,
      "Connection: close",
      "",
      body,
    ].join(HTTP_LINE_BREAK),
    () => {
      socket.destroy();
    },
  );
}

/** `answerClientError` in the shape Fastify's `clientErrorHandler` option takes. */
export function clientErrorHandler(
  this: FastifyInstance,
  err: ConnectionError,
  socket: Socket,
): void {
  answerClientError(err, socket, this.log);
}

/**
 * One error shape for the whole API, including the routes no epic wrote:
 * an unknown path answers like every other failure, so a client never has to
 * tell a Fastify payload apart from ours.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    const mapped = mapError(err);
    logError(request, err, mapped);

    reply.status(mapped.status).send(errorBodyOf(mapped, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    // Code and text come from the same sources as every other 4xx, and the
    // path is not echoed back: the body would then carry whatever the caller
    // typed into the url. Only a caller with the password gets here - basic
    // auth answers an unknown path with 401 first - and a run of 404 from it
    // is worth a line each, the short one: the path tried is not written.
    const mapped = clientError(NOT_FOUND_STATUS);
    logRejection(request, mapped);

    reply.status(mapped.status).send(errorBodyOf(mapped, request.id));
  });
}
