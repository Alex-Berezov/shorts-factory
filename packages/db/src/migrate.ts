import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, createDb } from "./client.js";

/**
 * Resolved from this module, not from `process.cwd()`: turbo runs tasks from
 * the package directory, the Compose one-shot service (E0-11) and CI run them
 * from elsewhere, and a folder missing at runtime would look like "no
 * migrations to apply" instead of an error.
 */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/**
 * Applies pending migrations and closes its own connection. Takes the url as
 * a parameter so the library stays free of configuration, and opens it through
 * `createDb` so the runner reaches the database with the same connection
 * options as the applications; a single connection is enough and keeps the
 * migration lock on one session.
 */
export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await closeDb(db);
  }
}
