import {
  ErrorBodySchema,
  HEALTH_ANSWER_STATUSES,
  HEALTH_STATUS_CODES,
  type HealthResponse,
  HealthResponseSchema,
  REQUEST_ID_HEADER,
  type SystemStatusResponse,
  SystemStatusResponseSchema,
} from "@sf/contracts";
import type { z } from "zod";
import { ApiContractError, ApiError } from "./errors.js";

/**
 * The part of `fetch` this client uses. A parameter rather than the global, so
 * a test hands over its own function instead of overwriting `globalThis` for
 * everything else running in the same process.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** How long a call may take before it is given up on, unless told otherwise. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How much of an answer is read, counted in bytes off the wire. The API
 * answers with a status report or an error envelope, both well under a
 * kilobyte; anything of this size is a proxy error page or something that is
 * not this API at all.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Header an answer declares its size with. */
const CONTENT_LENGTH_HEADER = "content-length";

/**
 * Longest correlation id taken off a header. Ours is a uuid; a value from
 * anywhere else is a header some hop set, and it travels from here into a log
 * line of web and into an error page.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/** One token of printable ascii - what an id looks like, and nothing else. */
const REQUEST_ID_SHAPE = /^[!-~]+$/;

export interface ApiClientOptions {
  /** Where the API is, with or without a trailing slash. */
  baseUrl: string;
  /**
   * The single admin password of the service. Basic auth carries a user name
   * as well, but the API never checks it (docs/DECISIONS.md, 08.09.2026), so
   * the caller has one secret to pass and not a pair to keep in step.
   */
  password: string;
  fetch?: FetchLike;
  /**
   * Deadline for a call, in milliseconds. The probes on the other side have
   * one of their own (`apps/api/src/lib/health.ts`); without one here a
   * server-rendered page that exists to show an outage hangs on it instead.
   */
  timeoutMs?: number;
}

export interface ApiClient {
  /** Liveness of the service; the one route that needs no password. */
  health(): Promise<HealthResponse>;
  /** Build fingerprint, uptime and the state of both dependencies. */
  systemStatus(): Promise<SystemStatusResponse>;
}

/**
 * The user name of the basic credentials. A label: the API compares the
 * password alone, and a value here only shows up in its access logs.
 */
const AUTH_USERNAME = "admin";

/**
 * Basic credentials as the API expects them, from the one secret it checks.
 *
 * Built with `TextEncoder` and `btoa` rather than `Buffer`, which keeps the
 * module to the web platform and off the Node globals: this package is source
 * compiled by the build of whoever imports it, so the less it assumes about
 * the runtime it lands in, the fewer ways that build has to fail. `btoa` takes
 * one byte per character, which is why the utf-8 bytes are spelled out first:
 * a non-ascii password would otherwise throw.
 */
function basicCredentials(password: string): string {
  const bytes = new TextEncoder().encode(`${AUTH_USERNAME}:${password}`);
  let latin1 = "";
  for (const byte of bytes) {
    latin1 += String.fromCharCode(byte);
  }
  return `Basic ${btoa(latin1)}`;
}

/** What one route says about how its answers are read. */
interface RouteOptions<T> {
  /** Whether the route checks the password - `/health` does not. */
  authorized: boolean;
  /** Statuses whose body is the answer of the route, not a failure. */
  answerStatuses?: readonly number[];
  /**
   * Whether an answer belongs on the status it arrived on. A route with more
   * than one answer status says the same thing twice - in the code and in the
   * body - and a hop in between can hand back one without the other.
   */
  agreesWithStatus?: (value: T, status: number) => boolean;
}

/** As much of a body as may be read, or the size at which reading stopped. */
type BodyRead = { read: true; text: string } | { read: false; bytes: number };

/**
 * Reads an answer, and stops reading at the limit.
 *
 * The limit is applied to the chunks as they arrive rather than to the string
 * afterwards, because `await response.text()` has already pulled the whole
 * body into memory by the time there is anything to measure - and the
 * declared `content-length` is no substitute for it: an answer that declares
 * no size passes that check untouched (`Number(null)` is 0), which is the
 * ordinary case for an answer sent in chunks. Bytes off the wire, not
 * characters: a length in code units is a different number from the one this
 * limit is named after.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<BodyRead> {
  const stream = response.body;
  if (stream === null) {
    return { read: true, text: "" };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        return { read: false, bytes };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Releases the connection instead of leaving it to the garbage collector,
    // both at the limit above and on a failure mid-stream. An errored stream
    // rejects here, and that rejection must not replace the failure being
    // reported.
    await reader.cancel().catch(() => undefined);
  }
  return { read: true, text: text + decoder.decode() };
}

/** The correlation id of an answer, if the header carries a usable one. */
function readRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER);
  if (
    value === null ||
    value.length > MAX_REQUEST_ID_LENGTH ||
    !REQUEST_ID_SHAPE.test(value)
  ) {
    return undefined;
  }
  return value;
}

/**
 * A client for this API and no other: every answer is parsed with the schema
 * the API declared its route with, so a field that changed shape is a failure
 * here - on the boundary, with the route in the message - instead of an
 * `undefined` three call frames away.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const given = options.fetch;
  // Called through a closure rather than stored: reading `globalThis.fetch` at
  // call time lets a runtime install its own transport after this client was
  // built, which is what the case "calls the fetch of the runtime, at the
  // moment of the call" holds it to.
  const call: FetchLike = given
    ? given
    : (input, init) => globalThis.fetch(input, init);
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const credentials = basicCredentials(options.password);

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    route: RouteOptions<T>,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (route.authorized) {
      headers.authorization = credentials;
    }

    let response: Response;
    try {
      response = await call(`${base}${path}`, {
        method: "GET",
        headers,
        // The password is for this API: a 3xx from a proxy would carry the
        // header wherever it points, and undici keeps the header across a
        // redirect to the same host. A moved route is a failure to see, not
        // one to follow.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // The route, not the url: `baseUrl` can carry credentials of its own
      // (`http://admin:pass@api:3001`), and this message travels into a log
      // line and into an error page.
      throw new ApiContractError(`GET ${path} did not reach the API`, {
        cause,
      });
    }

    const status = response.status;
    // Present on every answer this API builds, including the ones with no
    // envelope in the body: it is the id the service already wrote its log
    // line under, and the hardest failures to read are exactly the ones that
    // arrive without a body to take it from.
    const requestId = readRequestId(response);
    const context = { status, requestId };

    // A shortcut for the answer that says how big it is, so nothing is pulled
    // at all; the bound that holds in every case is the counted read below.
    const announced = Number(response.headers.get(CONTENT_LENGTH_HEADER));
    if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiContractError(
        `GET ${path} answered ${status} with a body of ${announced} bytes`,
        context,
      );
    }

    let body: BodyRead;
    try {
      body = await readBounded(response, MAX_BODY_BYTES);
    } catch (cause) {
      throw new ApiContractError(`GET ${path} answered an unreadable body`, {
        ...context,
        cause,
      });
    }
    if (!body.read) {
      throw new ApiContractError(
        `GET ${path} answered ${status} with a body past the size limit`,
        context,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch (cause) {
      // An empty body, a proxy error page, a gateway timeout in HTML: all of
      // them parse to nothing and none of them may be reported as an answer
      // of the API.
      throw new ApiContractError(`GET ${path} answered ${status}, not JSON`, {
        ...context,
        cause,
      });
    }

    const answered =
      response.ok || (route.answerStatuses?.includes(status) ?? false);
    if (answered) {
      const parsed = schema.safeParse(payload);
      if (parsed.success) {
        if (route.agreesWithStatus?.(parsed.data, status) === false) {
          throw new ApiContractError(
            `GET ${path} answered ${status} with the body of another status`,
            context,
          );
        }
        return parsed.data;
      }
      if (response.ok) {
        throw new ApiContractError(
          `GET ${path} answered a body the contract does not describe`,
          { ...context, cause: parsed.error },
        );
      }
      // A status the route answers with a body of its own carries failures
      // too - the API declares both shapes on it - so the envelope is tried
      // before this answer is called a drift.
    }

    const failure = ErrorBodySchema.safeParse(payload);
    if (!failure.success) {
      throw new ApiContractError(
        `GET ${path} answered ${status} outside the error contract`,
        context,
      );
    }
    throw new ApiError({ status, ...failure.data.error });
  }

  return {
    // No credentials on the public route: the API does not check them there,
    // and a password sent where nothing verifies it is a password in one more
    // access log.
    //
    // Which statuses carry an answer, and which answer belongs on which
    // status, comes from `@sf/contracts` - the same object the route builds
    // its `schema.response` from, so this end cannot fall behind that one.
    health: () =>
      request("/health", HealthResponseSchema, {
        authorized: false,
        answerStatuses: HEALTH_ANSWER_STATUSES,
        agreesWithStatus: (value, status) =>
          HEALTH_STATUS_CODES[value.status] === status,
      }),
    systemStatus: () =>
      request("/system/status", SystemStatusResponseSchema, {
        authorized: true,
      }),
  };
}
