import { env } from "@sf/config/server";
import { type NextRequest, NextResponse } from "next/server";

import {
  PRIVATE_CACHE_HEADERS,
  parseBasicPassword,
  passwordMatches,
  unauthorized,
} from "@/lib/basic-auth";

/**
 * Basic auth in front of every page of the dashboard.
 *
 * Runs in the Node runtime rather than on the edge, which is what lets it
 * read the password out of `@sf/config/server` like the rest of the server
 * code: one validated source, no `process.env` in `apps/web/src`
 * (docs/adr/0001-config-server-entry.md, docs/DECISIONS.md 10.10.2026).
 */
export function middleware(request: NextRequest): Response {
  const password = parseBasicPassword(request.headers.get("authorization"));
  if (password !== null && passwordMatches(password, env.ADMIN_PASSWORD)) {
    // Every page behind the password is private to whoever sent it: a
    // shared cache must neither keep it nor hand it to the next caller.
    return NextResponse.next({ headers: PRIVATE_CACHE_HEADERS });
  }
  return unauthorized();
}

export const config = {
  runtime: "nodejs",
  // Everything but the static build output: hashed chunks and the image
  // optimizer carry nothing secret and are fetched by the browser without
  // the prompt. Each exclusion ends at a path boundary, so `/_next/staticx`
  // or `/favicon.ico.bak` still ask for the password.
  matcher: ["/((?!_next/static/|_next/image(?:/|$)|favicon\\.ico$).*)"],
};
