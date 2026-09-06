import { env } from "@sf/config";
import postgres from "postgres";
import { type Db, createDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { assertLocalHost } from "./local-host-guard.js";

/**
 * The only database an integration test is allowed to touch. Spelled out as a
 * literal on purpose: the reset below drops schemas, so the guard must not be
 * derived from the same `DATABASE_URL` it is supposed to check.
 */
const TEST_DATABASE = "shorts_factory_test";

/**
 * Brings the test database to "freshly migrated" state.
 *
 * Both guards run first and throw instead of asserting, so they also hold when
 * the helper is called outside a test body. Both schemas go: the drizzle
 * journal lives in schema `drizzle`, and dropping only `public` would leave
 * `0000_core` marked as applied - the next `runMigrations` would then do
 * nothing and every table assertion would fail for the wrong reason.
 */
export async function resetTestDatabase(): Promise<void> {
  assertLocalHost(env.DATABASE_URL);
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<
      { name: string }[]
    >`SELECT current_database() AS name`;
    const name = rows[0]?.name;
    if (name !== TEST_DATABASE) {
      throw new Error(
        `refusing to reset database "${name}": integration tests only run against "${TEST_DATABASE}"`,
      );
    }
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  } finally {
    await sql.end();
  }

  await runMigrations(env.DATABASE_URL);
}

/** Connection for a test file; the caller closes it with `closeDb`. */
export function openTestDb(): Db {
  return createDb(env.DATABASE_URL, { max: 2 });
}

/** Raw client for assertions about the database itself (catalogs, bad input). */
export function openTestSql() {
  return postgres(env.DATABASE_URL, { max: 1 });
}
