// Named twice on purpose: a `globalSetup` runs in the main vitest process,
// `setupFiles` in the workers; both need the env before `@sf/config` parses it.
import "@sf/config/vitest/setup";
import { env } from "@sf/config";
import { assertLocalTestPostgres } from "../stack-guard.js";

/**
 * The entry check of an integration run that resets and migrates the test
 * database itself - `@sf/db`. A vitest `globalSetup` the preset sets for the
 * run (`intTestConfig({ entryCheck: "postgres" })` in `vitest.preset.ts`):
 * it runs once, before the first file, and a refusal stops the run before any
 * file opens a connection - whichever helper that file uses, or none.
 *
 * Postgres only: the suite does not touch Redis, and a run of it must not
 * fail on the Redis half of `.env.test`.
 */
export function setup(): void {
  assertLocalTestPostgres(env.DATABASE_URL);
}
