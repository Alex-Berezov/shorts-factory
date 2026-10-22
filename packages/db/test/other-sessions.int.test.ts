import { describe, expect, it, vi } from "vitest";
import { openMaintenanceSql, openTestSql } from "../test-support/fixture.js";
import {
  SESSION_CHECK_APPLICATION,
  SESSION_SAMPLING,
  assertNoOtherTestSessions,
} from "../test-support/other-sessions.js";
import { TEST_STACK } from "../test-support/stack-guard.js";

/**
 * The entry check against a second run on the test database
 * (`test-support/other-sessions.ts`), against the live Postgres: a client
 * session held open by this file is the second run, and the check refuses
 * it by its traits; with none, it passes - and leaves no session of its own
 * behind for the next one to find. Sessions it must not count - one on
 * another database of the server, a client that leaves between two reads,
 * the check of another run - are opened here too, each at a point of the
 * check it is told of (`onRead`), not raced against its pauses.
 */

/** How long a refusal may take: every read of the window, and room for the server. */
const REFUSAL_TIMEOUT_MS =
  SESSION_SAMPLING.samples * SESSION_SAMPLING.pauseMs + 10_000;

describe("assertNoOtherTestSessions", () => {
  it("passes when no other client is on the test database", async () => {
    await expect(assertNoOtherTestSessions()).resolves.toBeUndefined();
  });

  it(
    "refuses a session another client holds, naming it by its pid, without the connection string",
    async () => {
      const other = openTestSql();
      try {
        const [row] = await other<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;

        const refusal = assertNoOtherTestSessions();

        await expect(refusal).rejects.toThrow(
          `1 other session(s) on the test database ${TEST_STACK.database}: pid=${row?.pid} `,
        );
        await expect(refusal).rejects.toThrow(
          /application_name="postgres\.js" client_addr=\S+ state=idle backend_start=\d{4}-/,
        );
        await expect(refusal).rejects.toThrow(
          `pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (${row?.pid})`,
        );
        await expect(refusal).rejects.not.toThrow(/postgres(?:ql)?:\/\//);
      } finally {
        await other.end();
      }
    },
    REFUSAL_TIMEOUT_MS,
  );

  it("does not count a session on another database of the same server", async () => {
    // A client on another database of the same server - `pnpm dev` works on
    // the dev database of the same Postgres. Its `pg_stat_activity` is the
    // whole server's, so a case watches the test database from it without
    // being a session there itself. The maintenance database, opened the one
    // way the test support opens a database of the test server besides the
    // test one (`openMaintenanceSql`, through `assertTestServerDatabaseName`).
    const other = openMaintenanceSql();
    try {
      await other`SELECT 1`;

      await expect(assertNoOtherTestSessions()).resolves.toBeUndefined();
    } finally {
      await other.end();
    }
  });

  it("does not count a client that leaves between two reads: there in the first, gone by the second", async () => {
    // The backend of the package before, closing as the next one starts.
    const leaving = openTestSql();
    const watcher = openMaintenanceSql();
    try {
      const [row] = await leaving<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      const pid = row?.pid;
      const reads: number[][] = [];

      await expect(
        assertNoOtherTestSessions({
          onRead: async (read, counted) => {
            reads.push(counted.map((session) => session.pid));
            if (read !== 1) {
              return;
            }
            await leaving.end();
            // Gone from the server, not only closed on this side.
            await vi.waitFor(
              async () => {
                const [left] = await watcher<{ n: number }[]>`
                  SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid ?? -1}
                `;
                expect(left?.n).toBe(0);
              },
              { timeout: 5_000, interval: 20 },
            );
          },
        }),
      ).resolves.toBeUndefined();
      expect(reads).toEqual([[pid], []]);
    } finally {
      await leaving.end();
      await watcher.end();
    }
  });

  it(
    "names its own client, so that the check of another run meanwhile does not count it",
    async () => {
      // The check of a second run, started while this one holds its client:
      // to it, the client of this check is just another session.
      const nested: string[] = [];
      const watcher = openMaintenanceSql();
      try {
        await assertNoOtherTestSessions({
          onRead: async (read) => {
            if (read !== 1) {
              return;
            }
            const names = await watcher<{ name: string }[]>`
              SELECT application_name AS name FROM pg_stat_activity
               WHERE datname = ${TEST_STACK.database}
            `;
            nested.push(...names.map(({ name }) => name));
            await expect(assertNoOtherTestSessions()).resolves.toBeUndefined();
          },
        });
      } finally {
        await watcher.end();
      }

      expect(nested).toContain(SESSION_CHECK_APPLICATION);
    },
    REFUSAL_TIMEOUT_MS,
  );

  it("leaves no session of its own: a second check right after passes", async () => {
    await assertNoOtherTestSessions();

    await expect(assertNoOtherTestSessions()).resolves.toBeUndefined();
  });
});
