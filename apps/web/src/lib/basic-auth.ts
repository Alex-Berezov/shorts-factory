import { createHash, timingSafeEqual } from "node:crypto";

/**
 * HTTP Basic over the whole dashboard, as `src/middleware.ts` applies it.
 *
 * Kept apart from the middleware and from `@sf/config` so the parsing and the
 * comparison are tested on their own, without a password in the environment.
 * The user name is not checked: the service has one secret
 * (docs/DECISIONS.md, 08.09.2026), and the name is arbitrary caller input.
 */

/** Realm shown by the browser prompt - the same one the API sends. */
const REALM = "shorts-factory";

/** `Basic <token>`, with the scheme in any case (RFC 7617 / RFC 9110). */
const BASIC_SCHEME = /^basic[ \t]+([^ \t]+)[ \t]*$/i;

/** Strict base64 alphabet with optional padding; anything else is garbage. */
const BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The password out of an `Authorization` header, or `null` when the header is
 * absent, of another scheme, not base64, not utf-8, without the `:` that
 * separates the user name, or carries an empty password.
 *
 * The password is everything after the first `:` - a user name cannot hold a
 * colon, a password can (RFC 7617, section 2).
 */
export function parseBasicPassword(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const token = BASIC_SCHEME.exec(header.trim())?.[1];
  if (token === undefined || !BASE64_TOKEN.test(token)) {
    return null;
  }

  let decoded: string;
  try {
    const latin1 = atob(token);
    const bytes = Uint8Array.from(latin1, (char) => char.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const password = decoded.slice(separator + 1);
  return password === "" ? null : password;
}

/**
 * Constant-time comparison of two secrets of arbitrary length.
 *
 * A copy of `secretsMatch` in `apps/api/src/plugins/auth.ts`: both sides are
 * hashed first, because `timingSafeEqual` throws on buffers of different size
 * and would leak the password length through that throw. One shared module
 * for both services is E13-07 (docs/TECH_DEBT.md, `AUTH_USERNAME` row).
 */
export function passwordMatches(candidate: string, expected: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * Caching of every answer behind the password, the refusal included. A page
 * answered to one set of credentials must not be served by a proxy or a CDN
 * to the next caller (RFC 9111, section 3.5), and a 401 must not be kept for
 * the next request that does carry them. `no-store` alone is what holds:
 * a `Vary` on a page that passed would be replaced by Next with its own
 * (`rsc, next-router-state-tree, ...`) before it leaves, so it is not sent
 * there - only the refusal, which this module builds whole, carries one.
 */
export const PRIVATE_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
};

/** The answer that makes a browser ask for the password, without a body worth reading. */
export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      ...PRIVATE_CACHE_HEADERS,
      Vary: "Authorization",
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
