// Named twice on purpose: a `globalSetup` runs in the main vitest process,
// `setupFiles` in the workers; both need the env before `@sf/config` parses it.
import "@sf/config/vitest/setup";
import { env } from "@sf/config";
import { assertNoOtherTestSessions } from "../other-sessions.js";
import { type RunLock, lockRun } from "../run-lock.js";
import { assertLocalTestPostgres } from "../stack-guard.js";

/** The lock this run holds from `setup` to `teardown`. */
let held: RunLock | undefined;

/**
 * The entry check of an integration run that resets and migrates the test
 * database itself - `@sf/db`. A vitest `globalSetup` the preset sets for the
 * run (`intTestConfig({ entryCheck: "postgres" })` in `vitest.preset.ts`):
 * it runs once, before the first file, and a refusal stops the run before any
 * file opens a connection - whichever helper that file uses, or none.
 *
 * Postgres only: the suite does not touch Redis, and a run of it must not
 * fail on the Redis half of `.env.test`. Before the first reset the run takes
 * the run lock (`lockRun`, `../run-lock.ts`) and holds it until `teardown`:
 * a second run there would drop the schemas under the first. Under the lock,
 * no other client may be on the test database (`assertNoOtherTestSessions`)
 * - an open psql, a process a failed run left. Since both read the database,
 * a stack that is down is a refusal that names Compose
 * (`unreachableTestDatabase`), not a bare `ECONNREFUSED`.
 */
export async function setup(): Promise<void> {
  assertLocalTestPostgres(env.DATABASE_URL);
  held = await lockRun(() => assertNoOtherTestSessions());
}

/** Lets the run lock go once the last file of the run is done. */
export async function teardown(): Promise<void> {
  const lock = held;
  held = undefined;
  await lock?.release();
}
