import { afterAll, describe, expect, it, vi } from "vitest";
import { setup as postgresEntryCheck } from "../test-support/entry-check/postgres.js";
import { openTestSql } from "../test-support/fixture.js";
import { SESSION_CHECK_APPLICATION } from "../test-support/other-sessions.js";
import { RUN_LOCK_KEY, takeRunLock } from "../test-support/run-lock.js";
import { TEST_STACK } from "../test-support/stack-guard.js";

/**
 * The run lock (`test-support/run-lock.ts`) against the live Postgres. This
 * run holds the lock itself, from its entry check to its teardown, so the
 * entry check called again here is the second run - refused by the holder,
 * the session of the `globalSetup` of this run. A lock taken and let go
 * within one case uses a key of its own: the key of the run is never free
 * while the run is on.
 */

const sql = openTestSql();

afterAll(async () => {
  await sql.end();
});

/** A key no run takes, for the cases that take and let go a lock of their own. */
const CASE_KEY = RUN_LOCK_KEY + 2;

/** The pids holding `key` on the test database. */
async function holdersOf(key: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND ((classid::bigint << 32) | objid::bigint) = ${key}::bigint
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows.map(({ pid }) => pid);
}

/** The sessions of the client of the checks on the test database. */
async function checkClients(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${TEST_STACK.database}
      AND application_name = ${SESSION_CHECK_APPLICATION}`;
  return rows[0]?.n ?? -1;
}

describe("the run lock", () => {
  it("refuses the entry check of a second run while this run holds it, naming the holder by its pid", async () => {
    const [holder, ...more] = await holdersOf(RUN_LOCK_KEY);
    expect(holder).toBeTypeOf("number");
    expect(more).toEqual([]);

    const refusal = postgresEntryCheck();

    await expect(refusal).rejects.toThrow(
      `another integration run holds the run lock of the test database ${TEST_STACK.database}: pid=${holder} application_name="${SESSION_CHECK_APPLICATION}" backend_start=`,
    );
    await expect(refusal).rejects.toThrow(
      `pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (${holder})`,
    );
    await expect(refusal).rejects.not.toThrow(/postgres(?:ql)?:\/\//);
    // The refused check closed its client: the holder's is the one left.
    await vi.waitFor(async () => {
      expect(await checkClients()).toBe(1);
    });
    expect(await holdersOf(RUN_LOCK_KEY)).toEqual([holder]);
  });

  it("refuses a second take while it is held, and is taken once the holder lets it go", async () => {
    const first = await takeRunLock(CASE_KEY);
    let released = false;
    try {
      const [holder] = await holdersOf(CASE_KEY);
      expect(holder).toBeTypeOf("number");

      await expect(takeRunLock(CASE_KEY)).rejects.toThrow(
        `pid=${holder} application_name="${SESSION_CHECK_APPLICATION}" backend_start=`,
      );

      await first.release();
      released = true;
      // Unlocked before the close: free the moment the release is done.
      expect(await holdersOf(CASE_KEY)).toEqual([]);

      const again = await takeRunLock(CASE_KEY);
      await again.release();
    } finally {
      if (!released) {
        await first.release();
      }
    }
  });
});
