import { defineConfig } from "drizzle-kit";

/**
 * Only `drizzle-kit generate` is driven from this file: it reads the schema
 * and writes SQL, so no connection string is needed here. Migrations are
 * applied by `src/cli/migrate.ts`, the one place that reads `DATABASE_URL`
 * (through `@sf/config`, see docs/adr/0002-db-connection-and-cli-config.md).
 *
 * The `db:generate` script starts the drizzle-kit binary through `tsx`: its
 * own loader (esbuild-register) resolves a require literally, so the NodeNext
 * import `./radar.js` inside `src/schema/index.ts` fails with MODULE_NOT_FOUND,
 * while tsx maps the `.js` specifier onto the `.ts` source.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
