/**
 * What of the text of an error may go into a body or a log line: one printable
 * line, bounded, and a code only in the shape of an identifier. Knows nothing
 * of statuses - the caller passes the text to fall back on - so the mapping
 * (`error-mapping.ts`) and the request log (`request-log.ts`) both use it
 * without depending on each other.
 */

/** How much of an error message may travel to the caller. */
const MAX_MESSAGE_LENGTH = 200;
/** How long a code may be before it stops being an identifier. */
const MAX_CODE_LENGTH = 64;

/**
 * Everything that is not a character a body or a log line may carry: the
 * `C` classes (control, format, surrogate, private use, unassigned - `U+0085`
 * and the rest of the C1 set among them) and the `Z` classes, which hold every
 * separator there is (`U+2028`, `U+2029`) and every space that is not the
 * plain one (`U+00A0`).
 */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/** The one space that is a space: runs of it are collapsed, not replaced. */
const PLAIN_SPACE = " ";

/**
 * Printable, so an escape sequence cannot reach a terminal reading the body
 * and a line separator cannot split a log line in two.
 *
 * A range check (`>= 0x20 && !== 0x7f`) is not enough for either: `U+0085`,
 * `U+2028` and `U+00A0` all sit above it, `JSON.stringify` escapes none of
 * them, and a JavaScript reader of the resulting line breaks on the second.
 * The character classes state the rule once instead of listing code points.
 */
function isPrintable(char: string): boolean {
  return char === PLAIN_SPACE || !UNPRINTABLE.test(char);
}

/**
 * The text as one line of printable characters: every character `isPrintable`
 * refuses becomes a space, and runs of spaces collapse into one. Shared by
 * the body (`safeMessage`) and the log (`lib/request-log.ts`), so the two
 * cannot disagree about what a line break is.
 */
export function printableLine(text: string): string {
  const printable = Array.from(text)
    .map((char) => (isPrintable(char) ? char : " "))
    .join("");
  return printable.replace(/\s+/g, " ").trim();
}

/**
 * What of an error message may be shown to the caller; `fallback` - the
 * reason phrase of the status - when nothing of it may.
 *
 * Only one source gets here - a 4xx `AppError` written by our own domain code
 * - and even that is bounded and flattened rather than passed through:
 * `AppError` is constructed from whatever a `catch` block had at hand, and an
 * unbounded multi-line string would go into a JSON body and into a log line
 * as it is.
 */
export function safeMessage(message: unknown, fallback: string): string {
  if (typeof message !== "string") {
    return fallback;
  }
  const collapsed = printableLine(message);
  if (collapsed.length === 0) {
    return fallback;
  }
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}...`
    : collapsed;
}

/**
 * The written form of a code, as the convention in `@sf/contracts` states it:
 * `UPPER_SNAKE`, starting with a letter.
 *
 * Matching the shape is the whole test rather than one check among several,
 * because the things a code must not be do not share a character class. A url
 * a provider put in its error (`https://www.googleapis.com/youtube/v3?key=…`)
 * is one token, printable and under the length limit, so a filter built from
 * "not too long", "printable" and "no spaces" passes it on with the key in
 * it - proved by `test/error-sanitize.test.ts`, "refuses to send a code that
 * is a url with a key in it". An identifier is a narrow enough form to state
 * directly.
 *
 * What the shape does not do is tell a code from a secret: a url, a sentence
 * and a Google or Gemini key (`AIza…`, lower case in it) are refused, but a
 * token written entirely in `[A-Z0-9_]` - `SK_LIVE_51H8ZQ2E…` - is an
 * identifier by every rule here and goes out as it is. Whether a `code` can
 * carry a secret is decided where the `AppError` is built: the thrower names
 * the failure with a constant, never with a value it got from a provider.
 */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/**
 * What of an error code may be shown to the caller; `fallback` - the code of
 * the status - when the code is not one.
 *
 * The `code` of an `AppError` travels in both directions of the status range,
 * and it is built the same way its message is - `new AppError(String(err.code
 * ?? err.message), …, 502)` around a provider client is the shape E2 and E7
 * produce, so the field can arrive as a sentence, a url or a kilobyte of
 * provider output. A code is an identifier a client branches on, not prose:
 * it is either usable as it stands or it is not ours to send, so a value
 * outside the shape is replaced rather than trimmed - a truncated code would
 * name a different failure.
 */
export function safeCode(code: unknown, fallback: string): string {
  if (
    typeof code !== "string" ||
    code.length > MAX_CODE_LENGTH ||
    !CODE_SHAPE.test(code)
  ) {
    return fallback;
  }
  return code;
}
