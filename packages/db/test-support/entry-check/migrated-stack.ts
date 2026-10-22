// Named twice on purpose: a `globalSetup` runs in the main vitest process,
// `setupFiles` in the workers; both need the env before `@sf/config` parses it.
import "@sf/config/vitest/setup";
import { env } from "@sf/config";
import { assertMigrated } from "../fixture.js";
import { assertNoOtherTestSessions } from "../other-sessions.js";
import { type RunLock, lockRun } from "../run-lock.js";
import {
  assertLocalTestPostgres,
  assertLocalTestRedis,
} from "../stack-guard.js";

/** The lock this run holds from `setup` to `teardown`. */
let held: RunLock | undefined;

/**
 * The entry check of an integration run that works on a database `@sf/db`
 * has migrated - the api and the worker. A vitest `globalSetup` the preset
 * sets for the run (`intTestConfig({ entryCheck: "migrated-stack" })` in
 * `vitest.preset.ts`): it runs once, before the first file, and a refusal
 * stops the run before any file opens a connection - whichever helper that
 * file uses, or none.
 *
 * Both URLs of the stack are checked first, before any client: these two
 * guards are the barrier of the run. The checks after them guard the
 * Postgres URL again, each on its own (the rule of `../fixture.ts`: every
 * function that opens a client guards first), so that either holds when it
 * is called alone - a repetition on purpose, not a second barrier. Then the
 * run lock (`lockRun`, `../run-lock.ts`), held until `teardown`: another run
 * resets or rewrites what this one reads. Under it, no other client may be
 * on the test database (`assertNoOtherTestSessions`) - and both go before
 * `assertMigrated`, whose "not migrated, run `@sf/db` first" during the
 * reset of another run would send the reader to break that run as well. A
 * stack that is down is named as such by each. Then `assertMigrated`: the
 * migrations of the database, once per run instead of once per file.
 */
export async function setup(): Promise<void> {
  assertLocalTestRedis(env.REDIS_URL);
  assertLocalTestPostgres(env.DATABASE_URL);
  held = await lockRun(async () => {
    await assertNoOtherTestSessions();
    await assertMigrated();
  });
}

/** Lets the run lock go once the last file of the run is done. */
export async function teardown(): Promise<void> {
  const lock = held;
  held = undefined;
  await lock?.release();
}
