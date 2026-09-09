import "server-only";

/**
 * Server-only entry point for Next: importing it from a client component
 * fails the build.
 *
 * The package exists to take `ADMIN_PASSWORD` and put it into an
 * `Authorization` header, so there is no shape of it that belongs in a
 * browser bundle - a `"use client"` component that imported `createApiClient`
 * would ship the password in a static chunk and send basic credentials from
 * the browser. As in `@sf/config`, this module is both the `./server` subpath
 * and the `browser` condition of the root entry, so both specifiers hit the
 * same marker in a client bundle; the `server-only` marker itself must never
 * move into `index.ts`, which throws under every resolve condition except
 * `react-server` and would take down api, worker and vitest with it. See
 * `docs/adr/0001-config-server-entry.md` for the mechanism.
 *
 * The exports are the root entry itself rather than a list of their own: web
 * imports this module and nothing else of the package, so a second list would
 * be the one place a later export could be forgotten.
 */
export * from "./index.js";
