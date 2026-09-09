import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Round trip to the database for liveness checks (`/health` in `apps/api`).
 * Lives here so that a consumer does not have to depend on `drizzle-orm` and
 * `postgres` just to send one statement, which would put a driver into every
 * app that reports its own health.
 *
 * Throws whatever the driver throws - the caller decides what a failure means
 * and what of it may be shown.
 */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
