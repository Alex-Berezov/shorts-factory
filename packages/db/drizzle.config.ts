import { defineConfig } from "drizzle-kit";

/**
 * Only `drizzle-kit generate` and `drizzle-kit check` are driven from this
 * file: they read the schema and the migrations folder and write or check SQL,
 * so no connection string is needed here. scripts/check-schema-drift.mjs runs
 * both - CI as its step `Schema drift`, the gate `schema-drift` locally - and
 * fails on a schema change without its migration; generate gets the values
 * below on its command line there (held equal to this file by its unit).
 * Migrations are applied by `src/cli/migrate.ts`, the one place that reads
 * `DATABASE_URL` (through `@sf/config`, see
 * docs/adr/0002-db-connection-and-cli-config.md).
 *
 * The `db:generate` and `db:check` scripts start the drizzle-kit binary
 * through `tsx`: its own loader (esbuild-register) resolves a require
 * literally, so the NodeNext import `./radar.js` inside `src/schema/index.ts`
 * fails with MODULE_NOT_FOUND, while tsx maps the `.js` specifier onto the
 * `.ts` source.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
