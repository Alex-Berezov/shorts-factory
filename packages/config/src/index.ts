import { type EnvLike, bootstrapEnv } from "./env-file.js";
import { type Limits, buildLimits } from "./limits.js";
import { loadEnv, rejectedBuildLabelsOf } from "./load-env.js";
import { type BuildLabelName, type Env, EnvSchema } from "./schema.js";

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

/**
 * The one reading of the environment everything below is derived from: `env`
 * and the labels it dropped come from the same values, so a variable changed
 * between two reads cannot make them disagree.
 *
 * Read name by name, the names of the schema, through `process.env` itself:
 * on Windows it answers `REDIS_URL` for a variable the shell spelled
 * `Redis_Url`, and a copy of its keys keeps the spelling and loses the value.
 */
const snapshot: EnvLike = Object.fromEntries(
  Object.keys(EnvSchema.shape).map((name) => [name, process.env[name]]),
);

export const env: Env = loadEnv(snapshot);

/**
 * The build labels `env` reads as unset because they were set to something
 * that is not a label, from the same snapshot: the process that owns a logger
 * writes them, names only. The function behind it is not exported - a second
 * call would read the environment again, and the labels could stop being the
 * ones `env` dropped (docs/TECH_DEBT.md § E0-12G, item 1).
 */
export const rejectedBuildLabels: readonly BuildLabelName[] =
  rejectedBuildLabelsOf(snapshot);

/** Operational limits derived from the current env. */
export const limits: Limits = buildLimits(env);

export { loadEnv } from "./load-env.js";
export { buildLimits } from "./limits.js";
export type { BuildLabelName, Env } from "./schema.js";
export type { Limits } from "./limits.js";
