import { env } from "@sf/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.js";
import { pingDb } from "../src/health.js";
import { openTestSql } from "../test-support/fixture.js";
import { TEST_STACK } from "../test-support/stack-guard.js";

/**
 * Talks to the real Postgres from `infra/docker-compose.yml` (test database
 * `shorts_factory_test`, see `infra/postgres/init/01-test-db.sql`).
 * The queries go through the raw driver, with no schema and no drizzle: once
 * the file is loaded, a red case here says "the test database is not
 * reachable", not "a query of `@sf/db` is wrong". The client comes from the
 * fixture, behind the stack guard, like every other connection of the suite -
 * and the fixture imports `src/client.ts`, `src/catalog.ts` and
 * `src/migrate.ts`, so a file of `@sf/db` that fails to load fails this one
 * too, before any query: a failure to load points at the code, not at the
 * infrastructure.
 */
const sql = openTestSql();

beforeAll(async () => {
  // Gates the whole file: a future truncate/seed in this suite must never
  // run against anything but the isolated test database.
  const rows = await sql`SELECT current_database() AS name`;
  expect(rows[0]?.name).toBe(TEST_STACK.database);
});

afterAll(async () => {
  await sql.end();
});

describe("postgres connection", () => {
  it("runs SELECT 1 against the test database", async () => {
    const rows = await sql`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });
});

describe("pingDb", () => {
  /**
   * The liveness probe of `apps/api` has no unit test that means anything: it
   * exists to find out whether a real database answers, so it is checked
   * against one - and against an address where nothing listens, because
   * "reports a failure" is half of its job.
   */
  it("resolves against a reachable database", async () => {
    const db = createDb(env.DATABASE_URL);
    try {
      await expect(pingDb(db)).resolves.toBeUndefined();
    } finally {
      await closeDb(db);
    }
  });

  it("rejects when the database does not answer", async () => {
    const db = createDb("postgres://sf:sf@127.0.0.1:1/nowhere");
    try {
      await expect(pingDb(db)).rejects.toThrow();
    } finally {
      await closeDb(db);
    }
  });
});
