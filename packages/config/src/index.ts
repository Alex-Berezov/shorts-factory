import { bootstrapEnv } from "./env-file.js";
import { type Limits, buildLimits } from "./limits.js";
import { loadEnv } from "./load-env.js";
import type { Env } from "./schema.js";

/**
 * Typed, fail-fast environment configuration.
 * Every service imports `env` from here; startup crashes on invalid config.
 *
 * Node entry point: it reads files and `process.env`, so it is the `default`
 * condition of `@sf/config` only - a browser bundler resolves the same
 * specifier to `./server.js` and fails the build. Server code in Next imports
 * `@sf/config/server`; see `docs/adr/0001-config-server-entry.md`. The
 * `server-only` marker must never be added here: it throws under every resolve
 * condition except `react-server` and would take down api, worker, db and
 * vitest.
 */

/**
 * Fills `process.env` from the repository root `.env`: the file only supplies
 * what the process leaves unset, and is skipped under vitest. The rules and
 * their reasons live in `bootstrapEnv` - this module only triggers them once,
 * before the parse below.
 *
 * Note for operators: `pnpm dev`/`build`/`test` run through turbo in strict
 * env mode, which does not forward shell variables that `turbo.json` does not
 * declare, so under those commands the file is effectively the only source.
 */
bootstrapEnv(process.env);

export const env: Env = loadEnv();

/** Operational limits derived from the current env. */
export const limits: Limits = buildLimits(env);

export { loadEnv } from "./load-env.js";
export { buildLimits } from "./limits.js";
export type { Env } from "./schema.js";
export type { Limits } from "./limits.js";
