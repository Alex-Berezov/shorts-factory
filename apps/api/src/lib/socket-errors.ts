import { clientError } from "./error-mapping.js";
import { CLIENT_ERROR_STATUS, type MappedError } from "./mapped-error.js";

/**
 * The statuses a request is refused with when it breaks before it is a
 * request at all - on the socket, while Node is still parsing it - keyed by
 * the code of the Node error. Anything not named here is a 400, as in
 * Fastify's default handler, which this one replaces. Node's own fallback
 * (`socketOnError` in `_http_server.js`) names one code more - a chunk
 * extension over its limit (`HPE_CHUNK_EXTENSIONS_OVERFLOW`) is a 413 there -
 * and here it is a 400 like every other request the parser could not read.
 *
 * A `Map`, not an object literal: the key is a value off an error object, and
 * a lookup on a plain object would also find `constructor` or `toString`.
 */
const SOCKET_ERROR_STATUSES: ReadonlyMap<string, number> = new Map([
  ["ERR_HTTP_REQUEST_TIMEOUT", 408],
  ["HPE_HEADER_OVERFLOW", 431],
]);

/**
 * Status, code and text of a request Node refused on the socket
 * (`clientError`). Nothing of the Node error leaves: its code and message
 * name the parser (`HPE_HEADER_OVERFLOW`, `Parse Error: Header overflow`).
 */
export function mapSocketError(nodeCode: unknown): MappedError {
  return clientError(
    (typeof nodeCode === "string"
      ? SOCKET_ERROR_STATUSES.get(nodeCode)
      : undefined) ?? CLIENT_ERROR_STATUS,
  );
}
