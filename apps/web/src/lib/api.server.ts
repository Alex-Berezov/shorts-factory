import {
  type ApiClient,
  ApiContractError,
  ApiError,
  createApiClient,
} from "@sf/api-client/server";
import type { SystemStatusResponse } from "@sf/contracts";

/**
 * Access to the API from server components and route handlers of web.
 *
 * The client carries `ADMIN_PASSWORD` in every request, so it is built here
 * only - `@sf/api-client/server` fails a client bundle that imports it.
 */

/**
 * A client for the API, configured from `@sf/config/server`.
 *
 * The config is imported inside the function, not at the top of the module:
 * `next build` loads the modules of every page while collecting page data,
 * and a config parsed at that moment fails the build wherever there is no
 * `.env` - in CI, in the image build. A page that calls this at request time
 * reads the config at request time (docs/TECH_DEBT.md, `turbo.json` row).
 */
async function getApiClient(): Promise<ApiClient> {
  const { env } = await import("@sf/config/server");
  return createApiClient({
    baseUrl: env.API_INTERNAL_URL,
    password: env.ADMIN_PASSWORD,
  });
}

/**
 * What `/system` gets to draw. A failed call is a state of the page, not an
 * exception: the page exists to be read during an outage (docs/DECISIONS.md,
 * 13.09.2026 and 10.10.2026), so each way the API can fail to answer is a
 * kind of its own, carrying the code and the request id the operator looks up,
 * and never the message - that one can name hosts.
 */
export type SystemStatusResult =
  | { kind: "ok"; data: SystemStatusResponse }
  /** The API answered with its error envelope. */
  | { kind: "api-failed"; status: number; code: string; requestId: string }
  /**
   * No answer at all: refused, timed out, reset - or headers whose body did
   * not arrive before the timeout.
   */
  | { kind: "unreachable" }
  /** An answer that is not this API as the contract describes it. */
  | { kind: "contract"; requestId?: string };

/**
 * Reads `/system/status` and turns the two failures of the client into
 * results. Anything else - a defect of this code - is rethrown and lands in
 * `error.tsx`, rather than being drawn as an outage of the API.
 */
export async function loadSystemStatus(
  getClient: () => Promise<ApiClient> = getApiClient,
): Promise<SystemStatusResult> {
  const client = await getClient();
  try {
    return { kind: "ok", data: await client.systemStatus() };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        kind: "api-failed",
        status: error.status,
        code: error.code,
        requestId: error.requestId,
      };
    }
    if (error instanceof ApiContractError) {
      // The client leaves `status` unset exactly when no response arrived,
      // and an answer whose body stopped coming until the timeout fired is no
      // answer either: the API is slow, its schema did not drift.
      if (error.status === undefined || isTimeout(error.cause)) {
        return { kind: "unreachable" };
      }
      return error.requestId === undefined
        ? { kind: "contract" }
        : { kind: "contract", requestId: error.requestId };
    }
    throw error;
  }
}

/**
 * Whether a failure is the timeout of the request: the fetch rejects with a
 * `TimeoutError` (or an `AbortError` on runtimes that report the abort, not
 * its reason) when its signal fires, also while the body is being read.
 */
function isTimeout(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  );
}
