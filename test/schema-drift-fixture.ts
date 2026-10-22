/**
 * The output of drizzle-kit as `scripts/check-schema-drift.mjs` gets it,
 * recorded live from drizzle-kit 0.28.1 on 2026-10-22 (Windows, node 22) the
 * way the script starts it - its own `drizzleKitSpec`: this node with
 * `--import tsx ./node_modules/drizzle-kit/bin.cjs`, from `packages/db`, stdin
 * closed, stdout and stderr piped apart. Generate ran as `generate --dialect
 * postgresql --schema ./src/schema/index.ts --out <copy>`, `<copy>` a copy of
 * the migrations folder made by `mkdtempSync` under
 * `packages/db/node_modules/.cache` and named relative to `packages/db`;
 * check ran as `check` on the folder itself. Emoji, the `❯` of the question
 * and the escape that hides the cursor are as drizzle-kit printed them. Two
 * changes, so that a recording on another machine differs only where
 * drizzle-kit does: the root of the repository is written `<repo>`, and the
 * six random characters `mkdtempSync` gives a copy are written `XXXXXX`.
 *
 * The unit of the script (`check-schema-drift.test.ts`) runs on these texts,
 * never on drizzle-kit, so they are true only for the version they were
 * recorded with: the script stops on any other installed version
 * (`DRIZZLE_KIT_VERSION`), and the unit holds `RECORDED_VERSION` equal to it.
 *
 * Recording them again, on a new version: start each run through
 * `drizzleKitSpec` of the script with `spawnSync` (its `cwd`, `stdio` and
 * `timeout`, `encoding: "utf8"`), generate on a fresh copy of
 * `packages/db/migrations` under `COPY_PARENT` each time, removed after:
 * 1. `CLEAN_TREE` - generate on the tree as committed;
 * 2. `NEW_COLUMN` - generate after a nullable `drift_probe text` column is
 *    added to `api_usage_log` in `src/schema/system.ts`; `NEW_COLUMN_CHANGES`
 *    - `changesOf` of the copy before and after it;
 * 3. `AMBIGUOUS_RENAME` - generate after `prompt_version.template` is
 *    renamed `template_body` in the same file;
 * 4. `SNAPSHOT_COLLISION_RUN` - generate on a copy given a second snapshot,
 *    `meta/0001_snapshot.json`: `0000_snapshot.json` under another `id`, the
 *    same `prevId`, with a `0001_other.sql` and its entry in the journal;
 * 5. `CHECK_FINE` - check on the folder as committed;
 * 6. `SNAPSHOT_COLLISION_CHECK` - check with the files of 4 put into the
 *    folder itself;
 * 7. `MALFORMED_SNAPSHOT_CHECK` - check with `tables` of
 *    `meta/0000_snapshot.json` set to `5`.
 * Put the schema and the folder back after each (`git status --porcelain --
 * packages/db/src/schema packages/db/migrations` is as before), mask the
 * root and the random characters as above, and set `RECORDED_VERSION`; a
 * changed text of a sign goes to `SIGNS` of the script.
 */

/** The version of drizzle-kit these texts come from. */
export const RECORDED_VERSION = "0.28.1";

/** One run of drizzle-kit: what it printed, apart, and its exit code. */
export interface RecordedRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/** `generate` on a schema its migrations match: nothing written. */
export const CLEAN_TREE: RecordedRun = {
  stdout:
    "21 tables\nstory_cluster 4 columns 0 indexes 0 fks\nstory_cluster_video 2 columns 2 indexes 2 fks\ntracked_channel 8 columns 0 indexes 0 fks\ntracked_video 8 columns 1 indexes 1 fks\ntrend_signal 8 columns 2 indexes 1 fks\nvideo_stats_snapshot 7 columns 2 indexes 1 fks\nvideo_analysis 9 columns 1 indexes 1 fks\nidea 10 columns 1 indexes 1 fks\nidea_source_video 3 columns 2 indexes 2 fks\nproduction_package 8 columns 1 indexes 1 fks\nresearch_brief 9 columns 1 indexes 1 fks\nscript 11 columns 1 indexes 1 fks\nanalytics_daily 17 columns 0 indexes 1 fks\ndub_track 9 columns 1 indexes 1 fks\nown_video 9 columns 1 indexes 1 fks\nexperiment 8 columns 0 indexes 0 fks\nexperiment_recommendation 6 columns 1 indexes 1 fks\napi_usage_log 9 columns 1 indexes 0 fks\napp_setting 3 columns 0 indexes 0 fks\noauth_token 5 columns 0 indexes 0 fks\nprompt_version 5 columns 1 indexes 0 fks\n\nNo schema changes, nothing to migrate 😴\n",
  stderr: "",
  status: 0,
};

/** `generate` after a nullable column was added to `api_usage_log` without its migration: it wrote one into the copy. */
export const NEW_COLUMN: RecordedRun = {
  stdout:
    "21 tables\nstory_cluster 4 columns 0 indexes 0 fks\nstory_cluster_video 2 columns 2 indexes 2 fks\ntracked_channel 8 columns 0 indexes 0 fks\ntracked_video 8 columns 1 indexes 1 fks\ntrend_signal 8 columns 2 indexes 1 fks\nvideo_stats_snapshot 7 columns 2 indexes 1 fks\nvideo_analysis 9 columns 1 indexes 1 fks\nidea 10 columns 1 indexes 1 fks\nidea_source_video 3 columns 2 indexes 2 fks\nproduction_package 8 columns 1 indexes 1 fks\nresearch_brief 9 columns 1 indexes 1 fks\nscript 11 columns 1 indexes 1 fks\nanalytics_daily 17 columns 0 indexes 1 fks\ndub_track 9 columns 1 indexes 1 fks\nown_video 9 columns 1 indexes 1 fks\nexperiment 8 columns 0 indexes 0 fks\nexperiment_recommendation 6 columns 1 indexes 1 fks\napi_usage_log 10 columns 1 indexes 0 fks\napp_setting 3 columns 0 indexes 0 fks\noauth_token 5 columns 0 indexes 0 fks\nprompt_version 5 columns 1 indexes 0 fks\n\n[✓] Your SQL migration file ➜ node_modules\\.cache\\schema-drift-XXXXXX\\migrations\\0001_demonic_invisible_woman.sql 🚀\n",
  stderr: "",
  status: 0,
};

/** The files of the copy `NEW_COLUMN` added and changed, as `changesOf` names them. */
export const NEW_COLUMN_CHANGES: readonly string[] = [
  "+ 0001_demonic_invisible_woman.sql",
  "+ meta/0001_snapshot.json",
  "~ meta/_journal.json",
];

/** `generate` after `prompt_version.template` was renamed to `template_body`: with stdin closed it stops at the question, exits with 0 and writes nothing. */
export const AMBIGUOUS_RENAME: RecordedRun = {
  stdout:
    "\u001b[?25l\nIs template_body column in prompt_version table created or renamed from another column?\n❯ + template_body            create column\n  ~ template › template_body rename column",
  stderr: "",
  status: 0,
};

/** `generate` with two snapshots pointing to one parent - two branches that each added a migration: it says so and still exits with 0. */
export const SNAPSHOT_COLLISION_RUN: RecordedRun = {
  stdout:
    "Error: [node_modules\\.cache\\schema-drift-XXXXXX\\migrations\\meta\\0000_snapshot.json, node_modules\\.cache\\schema-drift-XXXXXX\\migrations\\meta\\0001_snapshot.json] are pointing to a parent snapshot: node_modules\\.cache\\schema-drift-XXXXXX\\migrations\\meta\\0000_snapshot.json/snapshot.json which is a collision.\n",
  stderr: "",
  status: 0,
};

/** `check` on a consistent folder. */
export const CHECK_FINE: RecordedRun = {
  stdout:
    "No config path provided, using default 'drizzle.config.ts'\nReading config file '<repo>\\packages\\db\\drizzle.config.ts'\nEverything's fine 🐶🔥\n",
  stderr: "",
  status: 0,
};

/** `check` on a folder with two snapshots pointing to one parent: it exits with 1. */
export const SNAPSHOT_COLLISION_CHECK: RecordedRun = {
  stdout:
    "No config path provided, using default 'drizzle.config.ts'\nReading config file '<repo>\\packages\\db\\drizzle.config.ts'\n[migrations\\meta\\0000_snapshot.json, migrations\\meta\\0001_snapshot.json] are pointing to a parent snapshot: migrations\\meta\\0000_snapshot.json/snapshot.json which is a collision.\n",
  stderr: "",
  status: 1,
};

/** `check` on a folder with a snapshot it cannot read (`tables` not a mapping): it exits with 1. */
export const MALFORMED_SNAPSHOT_CHECK: RecordedRun = {
  stdout:
    "No config path provided, using default 'drizzle.config.ts'\nReading config file '<repo>\\packages\\db\\drizzle.config.ts'\nmigrations\\meta\\0000_snapshot.json data is malformed\n",
  stderr: "",
  status: 1,
};

/**
 * The lines of a sign as drizzle-kit 0.28.1 printed them on Linux (container
 * `node:22`, node 22.23.3, 2026-10-20, started through the CLI of tsx with
 * stdin from `/dev/null`) - the platform of CI. Recorded for the signs only,
 * not as whole runs: the paths of a collision are written with `/`, the
 * question of a rename is the same text as on Windows.
 */
export const LINUX_SNAPSHOT_COLLISION_RUN: RecordedRun = {
  stdout:
    "Error: [migrations/meta/0000_snapshot.json, migrations/meta/0001_snapshot.json] are pointing to a parent snapshot: migrations/meta/0000_snapshot.json/snapshot.json which is a collision.\n",
  stderr: "",
  status: 0,
};

/** The question of the rename of `AMBIGUOUS_RENAME`, as printed on Linux. */
export const LINUX_AMBIGUOUS_RENAME: RecordedRun = {
  stdout:
    "Is template_body column in prompt_version table created or renamed from another column?\n❯ + template_body            create column\n  ~ template › template_body rename column",
  stderr: "",
  status: 0,
};
