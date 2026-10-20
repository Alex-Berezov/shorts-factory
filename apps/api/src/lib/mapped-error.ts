/**
 * The shape every failure is turned into before it is put into a body or a log
 * line, and the status bounds the modules around it share. A module of its
 * own, so the mapping (`error-mapping.ts`), the envelope (`error-response.ts`)
 * and the request log (`request-log.ts`) all read it from here: the envelope
 * imports neither of the others for it, and the mapping and the log, which do
 * import the envelope for its details, do not take the shape from it.
 */

/** Lowest status code that describes the request rather than the service. */
export const CLIENT_ERROR_STATUS = 400;

/** Lowest status code that means "our fault", not the caller's. */
export const SERVER_ERROR_STATUS = 500;

/** What one failure looks like on the wire, before it is put into a body. */
export interface MappedError {
  status: number;
  code: string;
  message: string;
  /** `undefined` when there is nothing a caller may see. */
  details: unknown;
}
