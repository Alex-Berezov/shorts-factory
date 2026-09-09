/**
 * What a call through this client can fail with.
 *
 * Two classes, never one: an answer the API built and an answer nobody built.
 * A 500 with the error envelope means the service saw the request, wrote a log
 * line and named the failure - the caller has a `code` to branch on and a
 * `requestId` to look up. A body that is not the envelope at all, an empty
 * response, a proxy's HTML or a socket that never opened mean the opposite:
 * there is nothing to branch on, and reporting it in the same shape would
 * invent a `code` the service never sent.
 */
export interface ApiErrorInput {
  status: number;
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

/** A failure the API reported in its own envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  /**
   * Only present when the API sent it. Declared rather than defined: a field
   * is initialised to `undefined` under `useDefineForClassFields`, and the
   * point of the envelope is that an absent `details` stays absent.
   */
  declare readonly details?: unknown;

  constructor(input: ApiErrorInput) {
    super(input.message);
    this.name = new.target.name;
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    if (input.details !== undefined) {
      this.details = input.details;
    }
  }
}

/**
 * The answer did not come from the API as we know it: the transport failed,
 * the body was not JSON, or it was JSON that no longer matches the contract.
 * The drift is caught here, on the boundary, rather than by a caller reading
 * `undefined` out of a field it was promised.
 */
export class ApiContractError extends Error {
  /** The HTTP status, when there was a response at all. */
  readonly status: number | undefined;
  /**
   * The `x-request-id` of the response, when it carried one. There is no
   * envelope to read a `requestId` out of here, and this is the failure that
   * needs one most: the API has already written its log line under this id,
   * and a body that is not the contract - a proxy page, a serialization
   * failure - says nothing else about which request it was.
   */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    // Written out with `| undefined` rather than as plain optional fields:
    // under `exactOptionalPropertyTypes` a caller cannot pass the value it
    // read off a header (`string | undefined`) into `requestId?: string`, and
    // the alternative is a branch per field at every call site.
    options: {
      status?: number | undefined;
      requestId?: string | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}
