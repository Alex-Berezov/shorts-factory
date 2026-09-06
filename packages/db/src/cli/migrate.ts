import { env } from "@sf/config";
import { runMigrations } from "../migrate.js";

/**
 * Entry point of `pnpm db:migrate`. Together with `seed.ts` it is the only
 * part of `@sf/db` that knows where the connection string comes from: the
 * library takes a url, the entry point reads the validated configuration
 * (docs/adr/0002-db-connection-and-cli-config.md).
 *
 * Silent on success - the exit code is the result, and application logging
 * belongs to api/worker (pino), not to a package script.
 */
await runMigrations(env.DATABASE_URL);
