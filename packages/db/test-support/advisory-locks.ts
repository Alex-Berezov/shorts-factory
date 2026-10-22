import type postgres from "postgres";
import { RUN_LOCK_KEY } from "./run-lock.js";

/**
 * Advisory locks as the integration tests of the migration runner read them.
 * `pg_locks` covers the whole server: a `pnpm db:migrate` or the Compose
 * `migrate` service holding or waiting for its lock on the dev database must
 * neither count here nor be taken for a session of the test - a case that
 * cancels the waiter it found would cancel someone else's run. So both reads
 * keep to the database `sql` is connected to.
 */

/**
 * Advisory locks granted to any session of `sql`'s database right now, but
 * the run lock (`RUN_LOCK_KEY`, `./run-lock.ts`): the entry check of the run
 * holds it on its own session through every file, and a case that reads "no
 * lock left" means the locks of the code under test. Only that key is left
 * out - any other lock, the one of the migration runner or one a case took,
 * still counts.
 */
export async function heldAdvisoryLocks(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND NOT (objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ${RUN_LOCK_KEY}::bigint)
  `;
  return rows[0]?.n ?? -1;
}

/**
 * Polls until a session of `sql`'s database waits for an advisory lock, at
 * most `timeoutMs`, and answers with its pid.
 */
export async function waitForAdvisoryWaiter(
  sql: postgres.Sql,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number }[]>`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    const pid = rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("no session started waiting for an advisory lock");
}
