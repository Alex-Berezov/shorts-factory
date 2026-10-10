import { env } from "@sf/config";
import { closeDb, createDb } from "../client.js";
import { migrateDb } from "../migrate.js";
import { processOutput, runEntry, runMigrateCli } from "./run.js";

/**
 * Entry point of `pnpm db:migrate` and the first half of the Compose `migrate`
 * service. Together with `seed.ts` it is the only part of `@sf/db` that knows
 * where the connection string comes from: the library takes a url, the entry
 * point reads the validated configuration
 * (docs/adr/0002-db-connection-and-cli-config.md).
 *
 * One line on success - how many migrations this run applied - so that
 * "worked" and "had nothing to do" are told apart without psql. What the run
 * does lives in `run.ts`; here are only the connection and the exit code.
 */
// A single connection: the advisory lock of `migrateDb` belongs to a session.
const db = createDb(env.DATABASE_URL, { max: 1 });

process.exitCode = await runEntry(
  () =>
    runMigrateCli(
      {
        migrate: (onReleaseError) => migrateDb(db, { onReleaseError }),
        close: () => closeDb(db),
      },
      processOutput,
    ),
  processOutput,
);
