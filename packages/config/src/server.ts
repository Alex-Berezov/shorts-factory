import "server-only";

/**
 * Server-only entry point for Next: importing it from a client component
 * fails the build. It is both the `./server` subpath and the `browser`
 * condition of the root entry, so `@sf/config` and `@sf/config/server` hit the
 * same marker in a client bundle. Next 15.5.25 on webpack points at the line
 * below and prints `You're importing a component that needs "server-only".
 * That only works in a Server Component which is not supported in the pages/
 * directory.` - the wording follows the bundler, the mechanism is the exact
 * `server-only` specifier. Same values as the root entry, parsed once - this
 * module only re-exports it. See `docs/adr/0001-config-server-entry.md`.
 */
export { buildLimits, env, limits, loadEnv } from "./index.js";
export type { Env } from "./schema.js";
export type { Limits } from "./limits.js";
