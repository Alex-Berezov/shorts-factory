import { env } from "@sf/config";
import { closeDb, createDb } from "../client.js";
import { migrateDb } from "../migrate.js";
import { seedAppSettings } from "../seed.js";
import { processOutput, runEntry, runSetupCli } from "./run.js";

/**
 * Entry point of the Compose `migrate` image: the migrations, then the seed,
 * in one process on one connection - the seed does not run after a failed
 * migration, and the exit code is that of the whole run. It is the `CMD` of
 * the `migrate` target of infra/docker/app.Dockerfile, which Compose runs
 * under `init: true`: this file sets no SIGTERM handler. `pnpm db:migrate`
 * and `pnpm db:seed` run their own entries. Same split as `migrate.ts` and
 * `seed.ts`: configuration is read here, the library takes the connection
 * (docs/adr/0002-db-connection-and-cli-config.md); what the run does lives
 * in `run.ts`.
 */
// A single connection: the advisory lock of `migrateDb` belongs to a session.
const db = createDb(env.DATABASE_URL, { max: 1 });

process.exitCode = await runEntry(
  () =>
    runSetupCli(
      {
        migrate: (onReleaseError) => migrateDb(db, { onReleaseError }),
        seed: () => seedAppSettings(db),
        close: () => closeDb(db),
      },
      processOutput,
    ),
  processOutput,
);
