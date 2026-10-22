import {
  AppError,
  BudgetExceededError,
  NotFoundError,
  ValidationError,
} from "@sf/core";
import { z } from "zod";
import type { AppInstance } from "../src/lib/app-instance.js";
import { errorResponses } from "../src/lib/define-route.js";

/**
 * The routes that fail on purpose and the values they fail with, shared by
 * the suites of the error handler: the envelope and the statuses
 * (`error-envelope.test.ts`), what is done to a code and a message
 * (`error-sanitize.test.ts`) and the log (`request-log.test.ts`).
 */

/** A url with a secret in it, the way a provider error carries one. */
const LEAKED_URL = "https://www.googleapis.com/youtube/v3?key=super-secret-key";
/** Text that only exists inside the thrown error. */
export const INTERNAL_MESSAGE = "connection to sf:hunter2@db failed";
/** A thrown value that is not an Error at all. */
export const THROWN_STRING = "boom-string-secret";
/** The same, as a number: a handler may throw one of those too. */
export const THROWN_NUMBER = 42;
/** A line break and a terminal escape, built by code point so that the
 * test source itself stays printable. */
export const LINE_BREAK = String.fromCharCode(10);
export const ESCAPE = String.fromCharCode(27);
/** A percent escape that decodes to nothing: the router rejects the url
 * before it looks for a route. */
export const BAD_URL_SUFFIX = "%zz";
export const BAD_URL = `/system/status${BAD_URL_SUFFIX}`;
/** Long, multi-line and with a terminal escape sequence in it. */
const WORDY_MESSAGE = `row rejected${LINE_BREAK}${ESCAPE}[31m${"very ".repeat(100)}long`;
/** A `code` built the way E2/E7 build one: from whatever the provider said. */
export const WORDY_CODE = `TIMEOUT${LINE_BREAK}${ESCAPE}[31m${"UP".repeat(100)}`;
/** The same, short enough to read but still not an identifier. */
export const SPACED_CODE = "connect ETIMEDOUT 142.250.1.1:443";
/** A `code` the size of a provider answer, with a forged second line. */
const HUGE_CODE = `${"A".repeat(10_000)}${LINE_BREAK}FORGED_LINE`;
/**
 * A short code padded with a run of blanks longer than the logged bound: one
 * line, once the run collapses into one space, and nothing to cut.
 */
const PADDED_CODE = `UPSTREAM${" ".repeat(300)}PADDED`;
/** The message of the error behind an `AppError`. */
export const ROOT_CAUSE = "socket hang up at the root";
/** A code with a line break in it, left non-enumerable on the error. */
const HIDDEN_CODE = `UPSTREAM${LINE_BREAK}HIDDEN`;
/** A code nothing needs to be done to, but kept where pino does not look. */
export const CLEAN_HIDDEN_CODE = "UPSTREAM_HIDDEN";
/** The same, behind a getter. */
export const GETTER_CODE = "UPSTREAM_GETTER";
/** What an object put into `code` says when it is turned into text. */
export const OBJECT_CODE_TEXT = "TEXT_OF_THE_THROWER";
/** A line separator, a next line and a no-break space: three characters a
 * range check on `0x20` lets through, `JSON.stringify` leaves as they are and
 * a reader of the resulting line breaks on. */
export const LINE_SEPARATOR = String.fromCharCode(0x2028);
export const NEXT_LINE = String.fromCharCode(0x85);
export const NO_BREAK_SPACE = String.fromCharCode(0xa0);
/** A code built from a provider answer that carried one of them. */
const SEPARATED_CODE = `TIMEOUT${LINE_SEPARATOR}UP`;
/** A message that carries all three. */
const SEPARATED_MESSAGE = `row${LINE_SEPARATOR}rejected${NEXT_LINE}here${NO_BREAK_SPACE}now`;

/**
 * Routes that exist only here: the error handler is what is under test, and
 * the application has no handler whose job is to throw.
 */
export function registerFailingRoutes(app: AppInstance): void {
  // Declared exactly as the real routes declare them: with the wildcards of
  // `errorResponses()`, every answer below leaves through the zod serializer
  // instead of being written out as it is, so a shape the envelope schema
  // does not describe - `details` above all - fails here rather than in the
  // first epic that adds a route.
  //
  // A fresh object per route: one shared config would be one mutable object
  // behind every route, and the first route that adds a `querystring` to it
  // would hand that to all the others.
  const failing = () => ({ schema: { response: errorResponses() } });

  app.get(
    "/test/validated",
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int() }),
        response: {
          ...errorResponses(),
          200: z.object({ limit: z.number() }),
        },
      },
    },
    async (request) => ({ limit: request.query.limit }),
  );

  app.get("/test/not-found", failing(), async () => {
    throw new NotFoundError("idea 42 does not exist");
  });

  app.get("/test/leaky", failing(), async () => {
    // Exactly the shape docs/TECH_DEBT.md warns about: an upstream error
    // object handed to `details` as it is.
    throw new ValidationError("upstream rejected the request", {
      config: { url: LEAKED_URL },
    });
  });

  app.get("/test/budget", failing(), async () => {
    throw new BudgetExceededError("daily gemini budget spent", {
      provider: "gemini",
      spent: 5.25,
      cap: 5,
    });
  });

  app.get("/test/boom", failing(), async () => {
    throw new Error(INTERNAL_MESSAGE);
  });

  // A handler may throw anything at all, and the error handler is the last
  // thing standing between that value and the client.
  app.get("/test/thrown-string", failing(), async () => {
    throw THROWN_STRING;
  });

  app.get("/test/thrown-null", failing(), async () => {
    throw null;
  });

  app.get("/test/thrown-number", failing(), async () => {
    throw THROWN_NUMBER;
  });

  app.get("/test/upstream", failing(), async () => {
    // The shape E2/E7 will produce: a provider failure wrapped into a 5xx
    // AppError, message and all.
    throw new AppError("GEMINI_FAILED", `gemini rejected ${LEAKED_URL}`, 502);
  });

  app.get("/test/foreign-client-error", failing(), async () => {
    // The shape an http client rejects a response with: a plain `Error` with
    // a `statusCode` on it, and the request line - api key and all - as its
    // message.
    throw Object.assign(new Error(`GET ${LEAKED_URL} failed`), {
      statusCode: 403,
    });
  });

  app.get("/test/unlisted-status", failing(), async () => {
    // A 4xx nobody put in the code table, in the shape `@fastify/error`
    // builds: a status, an `FST_`-prefixed code and a message about the
    // request.
    throw Object.assign(new Error("nothing brews here"), {
      statusCode: 418,
      code: "FST_ERR_TEAPOT",
    });
  });

  app.get("/test/absurd-status", failing(), async () => {
    throw new AppError("WEIRD", "status nobody can send", 700);
  });

  app.get("/test/wordy", failing(), async () => {
    throw new AppError("WORDY", WORDY_MESSAGE, 409);
  });

  app.get("/test/wordy-code", failing(), async () => {
    throw new AppError(WORDY_CODE, "upstream timed out", 502);
  });

  app.get("/test/spaced-code", failing(), async () => {
    throw new AppError(SPACED_CODE, "upstream timed out", 502);
  });

  app.get("/test/separated-code", failing(), async () => {
    throw new AppError(SEPARATED_CODE, "upstream timed out", 502);
  });

  app.get("/test/separated-message", failing(), async () => {
    throw new AppError("SEPARATED", SEPARATED_MESSAGE, 409);
  });

  app.get("/test/client-spaced-code", failing(), async () => {
    // A 4xx built the same careless way: the failure is the caller's, and the
    // `code` still came from a provider answer.
    throw new AppError(SPACED_CODE, "channel id is not a channel id", 400);
  });

  app.get("/test/leaked-url-code", failing(), async () => {
    // The url of the failed call as the `code`: one token, no spaces, no
    // control characters and well under the length limit, so every bound but
    // the shape of an identifier lets it through with the key in it.
    throw new AppError(LEAKED_URL, "upstream rejected the call", 502);
  });

  app.get("/test/client-leaked-url-code", failing(), async () => {
    throw new AppError(LEAKED_URL, "channel id is not a channel id", 400);
  });

  // A path parameter the router measures before it looks any further: one
  // over `maxParamLength` (100) is refused with 414 before auth runs.
  app.get("/test/param/:id", failing(), async () => undefined);

  app.get("/test/insufficient-storage", failing(), async () => {
    throw new AppError("DISK_FULL", "render volume is full", 507);
  });

  app.get("/test/phraseless-server-status", failing(), async () => {
    throw new AppError("EDGE_FAILED", "nothing to say", 599);
  });

  app.get("/test/huge-code", failing(), async () => {
    // Ten kilobytes of provider output with a line break in it, as `code`.
    throw new AppError(HUGE_CODE, "upstream answered with a novel", 502);
  });

  app.get("/test/padded-code", failing(), async () => {
    throw new AppError(PADDED_CODE, "upstream answered with blanks", 502);
  });

  app.get("/test/caused", failing(), async () => {
    // `details` filled by the thrower and a cause behind it: the two together
    // are what a `catch` around a provider call produces.
    throw Object.assign(
      new ValidationError("upstream rejected the request", {
        config: { url: LEAKED_URL },
      }),
      { cause: new Error(ROOT_CAUSE) },
    );
  });

  // `code` is typed `string`, but nothing stops a plain JavaScript caller or
  // a subclass from leaving something else in it, or from hiding it.
  app.get("/test/null-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "code went missing", 502);
    Object.defineProperty(err, "code", { value: null });
    throw err;
  });

  // A code that is there and makes no line: nothing for a reader either.
  app.get("/test/empty-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "code is empty", 502);
    Object.defineProperty(err, "code", { value: "", enumerable: true });
    throw err;
  });

  app.get("/test/blank-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "code is blank", 502);
    Object.defineProperty(err, "code", {
      value: " \t\u0000 ",
      enumerable: true,
    });
    throw err;
  });

  app.get("/test/numeric-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "code is a number", 502);
    Object.defineProperty(err, "code", { value: 503 });
    throw err;
  });

  app.get("/test/hidden-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "code is not enumerable", 502);
    Object.defineProperty(err, "code", {
      value: HIDDEN_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/clean-hidden-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "clean code, not enumerable", 502);
    Object.defineProperty(err, "code", {
      value: CLEAN_HIDDEN_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/getter-code", failing(), async () => {
    const err = new AppError("PLACEHOLDER", "clean code behind a getter", 502);
    Object.defineProperty(err, "code", {
      get: (): string => GETTER_CODE,
      enumerable: false,
    });
    throw err;
  });

  app.get("/test/object-code", failing(), async () => {
    // Turning this into text runs a function of the thrower's.
    const err = new AppError("PLACEHOLDER", "code is an object", 502);
    Object.defineProperty(err, "code", {
      value: { toString: (): string => OBJECT_CODE_TEXT },
    });
    throw err;
  });

  app.get("/test/foreign-server-error", failing(), async () => {
    // The shape `@fastify/under-pressure` and http clients produce: a plain
    // error with a 5xx `statusCode`, a code of its own and an inside message.
    throw Object.assign(new Error(`overloaded, ${INTERNAL_MESSAGE}`), {
      statusCode: 503,
      code: "FST_UNDER_PRESSURE",
    });
  });

  app.get("/test/foreign-absurd-status", failing(), async () => {
    throw Object.assign(new Error("redirect elsewhere"), { statusCode: 302 });
  });

  app.get("/test/phraseless-client-status", failing(), async () => {
    throw Object.assign(new Error("client went away"), { statusCode: 499 });
  });
}
