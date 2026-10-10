import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Whether `qualifiedName` (`schema.table`) exists. A query of its own,
 * because a reference to a missing table fails when the statement is planned,
 * even inside a branch that would not run - callers ask first, then query.
 */
export async function tableExists(
  db: Db,
  qualifiedName: string,
): Promise<boolean> {
  const rows = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${qualifiedName}) is not null as present`,
  );
  return rows[0]?.present === true;
}
