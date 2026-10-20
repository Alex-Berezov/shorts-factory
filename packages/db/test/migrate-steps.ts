import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { vi } from "vitest";
import type { Db } from "../src/client.js";
import type { MigrateStatement } from "../src/migrate.js";

/**
 * The statements of `migrateDb` by the name of their step: each one opens its
 * text with `/* step:<name> *\/`, the comment a log of Postgres shows too.
 */
const dialect = new PgDialect();

/** The step a query handed to `execute` belongs to, from its text. */
export function stepOf(query: SQLWrapper | string): string | undefined {
  const text =
    typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql;
  return /^\/\* step:([a-z_]+) \*\//.exec(text)?.[1];
}

/**
 * Makes the statement of `migrateDb` named `name` fail, and lets every other
 * one - drizzle's migrator does not go through `execute` - reach the
 * database. `hits` counts how often the step came: a case that expects it
 * checks it, or a name that never reaches `execute` would leave the case
 * green for nothing. `steps` lists every named step that came, in order, the
 * failed one included - for a case about what runs after a failure.
 */
export function failStep(
  db: Db,
  name: MigrateStatement,
  error: unknown,
): { readonly hits: number; readonly steps: readonly string[] } {
  const execute = db.execute.bind(db);
  const fault = { hits: 0, steps: [] as string[] };
  vi.spyOn(db, "execute").mockImplementation((query) => {
    const came = stepOf(query);
    if (came !== undefined) fault.steps.push(came);
    if (came === name) {
      fault.hits += 1;
      return Promise.reject(error) as ReturnType<typeof execute>;
    }
    return execute(query);
  });
  return fault;
}
