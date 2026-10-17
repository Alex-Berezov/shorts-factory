import { env } from "@sf/config";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { type Db, createDb } from "../src/client.js";
import { migrationsFolder, runMigrations } from "../src/migrate.js";
import {
  type Migration,
  isMigrated,
  journalMigrations,
  migrationGap,
} from "./migration-check.js";
import {
  assertLocalTestPostgres,
  assertLocalTestRedis,
  assertTestDatabaseName,
} from "./stack-guard.js";

/**
 * The integration fixture of the test database, shared by the integration
 * suites of `@sf/db`, `apps/api` and `apps/worker`
 * (docs/adr/0011-vitest-preset-and-test-support.md). Only integration files
 * import it: it reads the parsed environment, which is `.env.test` under
 * `@sf/config/vitest/setup`.
 *
 * Every function that touches the database runs `assertLocalTestPostgres` on
 * the URL of the environment first, and throws instead of asserting, so the
 * guard also holds when a helper is called outside a test body. Only
 * `assertMigrated`, the entry check of a suite, looks at the Redis URL too.
 */

export { defaultQueueSwitches } from "../src/seed.js";

/** Database handle for a test file; the caller closes it with `closeDb`. */
export function openTestDb(): Db {
  assertLocalTestPostgres(env.DATABASE_URL);
  return createDb(env.DATABASE_URL, { max: 2 });
}

/** Raw client for assertions about the database itself (catalogs, bad input). */
export function openTestSql(): postgres.Sql {
  assertLocalTestPostgres(env.DATABASE_URL);
  return postgres(env.DATABASE_URL, { max: 1 });
}

/**
 * Both schemas dropped, nothing migrated - for tests about the migration
 * runner itself. The name is checked a second time against what the server
 * says it is connected to (`current_database()`), not only against the URL:
 * this drops schemas.
 */
export async function emptyTestDatabase(): Promise<void> {
  const sql = openTestSql();
  try {
    const rows = await sql<
      { name: string }[]
    >`SELECT current_database() AS name`;
    assertTestDatabaseName(rows[0]?.name);
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  } finally {
    await sql.end();
  }
}

/**
 * Brings the test database to "freshly migrated" state. Both schemas go: the
 * drizzle journal lives in schema `drizzle`, and dropping only `public` would
 * leave `0000_core` marked as applied - the next `runMigrations` would then do
 * nothing and every table assertion would fail for the wrong reason.
 */
export async function resetTestDatabase(): Promise<void> {
  await emptyTestDatabase();
  await runMigrations(env.DATABASE_URL);
}

/**
 * The entry check of an integration suite that does not migrate the database
 * itself - the api and the worker rely on `@sf/db`'s `test:int` (which resets
 * and migrates) having run first, or on `pnpm db:migrate` against `.env.test`.
 * Run once per integration run, before the first file, by the entry check the
 * preset gives those suites (`./entry-check/migrated-stack.ts`):
 *
 * - the whole stack is checked by the environment's URLs, Redis included -
 *   the worker suite forks processes that read `REDIS_URL` as is;
 * - the database must carry exactly the migrations of `packages/db/migrations`:
 *   none missing, none the folder does not know, and none whose file was
 *   edited after it was applied (by the hash drizzle stores);
 * - a database that cannot be reached is one error that names its address
 *   and - for a refused or timed-out connection, a stack that is not up -
 *   Compose and `.env.test`, not a bare `ECONNREFUSED`.
 *
 * Without it a broken order is a red run about missing tables - for a reason
 * that has nothing to do with the change under test.
 */
export async function assertMigrated(): Promise<void> {
  assertLocalTestRedis(env.REDIS_URL);
  const journal = journalMigrations(readMigrationFiles({ migrationsFolder }));
  const sql = openTestSql();
  let applied: Migration[];
  try {
    applied = await readAppliedMigrations(sql);
  } catch (error) {
    // The guard has passed: the address is local and holds no password.
    const where = new URL(env.DATABASE_URL).host;
    const reason = reasonOf(error);
    const hint = STACK_DOWN.has(reason)
      ? " - is the local Compose stack up (`docker compose -f infra/docker-compose.yml up -d`) and .env.test pointing at it?"
      : "";
    throw new Error(
      `cannot read the migrations of the test database on ${where} (${reason})${hint}`,
      { cause: error },
    );
  } finally {
    await sql.end();
  }
  const gap = migrationGap(journal, applied);
  if (!isMigrated(gap)) {
    throw new Error(
      `the test database is not migrated to packages/db/migrations (missing: ${listOf(gap.missing)}; not in the folder: ${listOf(gap.unknown)}; edited after it was applied: ${listOf(gap.changed)}; applied more than once: ${listOf(gap.duplicated)}) - run \`pnpm db:migrate\` against .env.test or \`pnpm --filter @sf/db test:int\` first`,
    );
  }
}

async function readAppliedMigrations(sql: postgres.Sql): Promise<Migration[]> {
  const table = await sql<{ present: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
  `;
  if (!table[0]?.present) {
    return [];
  }
  return sql<{ createdAt: string; hash: string }[]>`
    SELECT created_at::text AS "createdAt", hash FROM drizzle.__drizzle_migrations
  `;
}

/**
 * Codes of a connection that never reached a server - what a Compose stack
 * that is not up looks like. Anything else (a wrong password, a missing
 * database) is answered by a server, and a hint about starting one would send
 * the reader the wrong way.
 */
const STACK_DOWN = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT",
]);

/** The code of a driver error (`ECONNREFUSED`, `3D000`), or its message. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" ? code : error.message;
  }
  return String(error);
}

function listOf(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}
