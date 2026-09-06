import { env } from "@sf/config";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Talks to the real Postgres from `infra/docker-compose.yml` (test database
 * `shorts_factory_test`, see `infra/postgres/init/01-test-db.sql`).
 * Deliberately uses the raw driver and no schema: this file answers "is the
 * test database reachable at all", so a failure here points at the
 * infrastructure and not at `@sf/db`.
 */
const sql = postgres(env.DATABASE_URL);

beforeAll(async () => {
  // Gates the whole file: a future truncate/seed in this suite must never
  // run against anything but the isolated test database.
  const rows = await sql`SELECT current_database() AS name`;
  expect(rows[0]?.name).toBe("shorts_factory_test");
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
