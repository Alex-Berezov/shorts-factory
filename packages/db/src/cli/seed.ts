import { env } from "@sf/config";
import { closeDb, createDb } from "../client.js";
import { hasAppSettingTable, seedAppSettings } from "../seed.js";
import { processOutput, runEntry, runSeedCli } from "./run.js";

/**
 * Entry point of `pnpm db:seed` and the second half of the Compose `migrate`
 * service. Same split as `migrate.ts`: configuration is read here, the library
 * takes the connection (docs/adr/0002-db-connection-and-cli-config.md). Safe
 * to run repeatedly: the defaults are merged under the stored rows - missing
 * rows and missing keys are added, the operator's value wins, a run that
 * changes nothing leaves `updated_at` alone.
 */
const db = createDb(env.DATABASE_URL, { max: 1 });

process.exitCode = await runEntry(
  () =>
    runSeedCli(
      {
        hasSettingsTable: () => hasAppSettingTable(db),
        seed: () => seedAppSettings(db),
        close: () => closeDb(db),
      },
      processOutput,
    ),
  processOutput,
);
