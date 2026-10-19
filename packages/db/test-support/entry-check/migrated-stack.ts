// Named twice on purpose: a `globalSetup` runs in the main vitest process,
// `setupFiles` in the workers; both need the env before `@sf/config` parses it.
import "@sf/config/vitest/setup";
import { assertMigrated } from "../fixture.js";

/**
 * The entry check of an integration run that works on a database `@sf/db`
 * has migrated - the api and the worker. A vitest `globalSetup` the preset
 * sets for the run (`intTestConfig({ entryCheck: "migrated-stack" })` in
 * `vitest.preset.ts`): it runs once, before the first file, and a refusal
 * stops the run before any file opens a connection - whichever helper that
 * file uses, or none.
 *
 * `assertMigrated` checks both URLs of the stack, then the migrations of the
 * database, once per run instead of once per file.
 */
export async function setup(): Promise<void> {
  await assertMigrated();
}
