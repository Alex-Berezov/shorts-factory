import { env } from "@sf/config";
import { closeDb, createDb } from "../client.js";
import { seedAppSettings } from "../seed.js";

/**
 * Entry point of `pnpm db:seed`. Same split as `migrate.ts`: configuration is
 * read here, the library takes the connection
 * (docs/adr/0002-db-connection-and-cli-config.md). Safe to run repeatedly: the
 * defaults are merged under the stored rows - missing rows and missing keys
 * are added, the operator's value wins, a run that changes nothing leaves
 * `updated_at` alone.
 */
const db = createDb(env.DATABASE_URL, { max: 1 });
try {
  await seedAppSettings(db);
} finally {
  await closeDb(db);
}
