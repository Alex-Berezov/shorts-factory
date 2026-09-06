import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Talks to the real Postgres from `infra/docker-compose.yml` (test database
 * `shorts_factory_test`, see `infra/postgres/init/01-test-db.sql`).
 * Does not import `@sf/db`: that module opens a connection on import (D3,
 * fixed in E0-04), which would leak a second client here.
 */
const sql = postgres(process.env.DATABASE_URL ?? "");

afterAll(async () => {
  await sql.end();
});

describe("postgres connection", () => {
  it("runs SELECT 1 against the test database", async () => {
    const rows = await sql`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });
});
