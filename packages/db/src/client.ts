import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/**
 * A connection is opened by an explicit call, never by importing the package
 * (D3): a module-level `postgres(url)` made every importer - `tsc`, vitest,
 * drizzle-kit, the Next build - depend on a reachable database and on a parsed
 * `DATABASE_URL`. The url is a parameter, so the library side of `@sf/db`
 * stays on `db -> core` and only `src/cli/**` reads configuration
 * (docs/adr/0002-db-connection-and-cli-config.md).
 */
export function createDb(url: string, opts?: { max?: number }) {
  const client = postgres(url, { max: opts?.max ?? 10 });
  return drizzle(client, { schema });
}

/** Handle every repository and migration helper takes as its first argument. */
export type Db = ReturnType<typeof createDb>;

/**
 * Closes the underlying postgres-js client. The driver exposes it as
 * `$client`, so callers do not have to carry the client next to the `Db`.
 */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
