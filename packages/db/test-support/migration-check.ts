/**
 * The pure half of `assertMigrated` (`./fixture.ts`): how the migrations a
 * test database carries differ from the ones in `packages/db/migrations`.
 * Kept apart from the fixture, which reads the environment and connects, so
 * `pnpm test` checks it on every run.
 *
 * A migration is matched by its `when` - what drizzle writes into
 * `created_at` of `drizzle.__drizzle_migrations` - and compared by its hash,
 * the sha256 of the `.sql` file drizzle stores next to it. A file edited
 * after it was applied keeps its `when`, so the hash is what tells it apart.
 */

/** One migration: the `when` of its journal entry and the hash of its file. */
export interface Migration {
  readonly createdAt: string;
  readonly hash: string;
}

/** What `migrationGap` found; every list empty means "migrated". */
export interface MigrationGap {
  /** In the journal, not in the database. */
  readonly missing: string[];
  /** In the database, not in the journal. */
  readonly unknown: string[];
  /** In both, with another hash: the file was edited after it was applied. */
  readonly changed: string[];
  /**
   * In the database more than once: drizzle applies a migration once, so a
   * second row is a journal written by hand or by another tool, and the
   * schema behind it is not the one the folder describes.
   */
  readonly duplicated: string[];
}

/**
 * How `applied` - the rows of `drizzle.__drizzle_migrations` - differs from
 * `journal` - the migrations of the folder. Each list names migrations by
 * their `when`, once each, in the order of the list it comes from.
 */
export function migrationGap(
  journal: readonly Migration[],
  applied: readonly Migration[],
): MigrationGap {
  // Every hash a `when` was applied with, not the last one: a duplicate row
  // must not hide an edited file behind a matching one.
  const appliedHashes = new Map<string, string[]>();
  for (const m of applied) {
    appliedHashes.set(m.createdAt, [
      ...(appliedHashes.get(m.createdAt) ?? []),
      m.hash,
    ]);
  }
  const inJournal = new Set(journal.map((m) => m.createdAt));
  const whens = [...appliedHashes.keys()];
  return {
    missing: journal
      .filter((m) => !appliedHashes.has(m.createdAt))
      .map((m) => m.createdAt),
    unknown: whens.filter((when) => !inJournal.has(when)),
    changed: journal
      .filter((m) =>
        (appliedHashes.get(m.createdAt) ?? []).some((hash) => hash !== m.hash),
      )
      .map((m) => m.createdAt),
    duplicated: whens.filter(
      (when) => (appliedHashes.get(when) ?? []).length > 1,
    ),
  };
}

/** True when the database carries exactly the migrations of the journal. */
export function isMigrated(gap: MigrationGap): boolean {
  return (
    gap.missing.length === 0 &&
    gap.unknown.length === 0 &&
    gap.changed.length === 0 &&
    gap.duplicated.length === 0
  );
}

/**
 * The migrations of the folder as drizzle reads them (`readMigrationFiles`
 * of `drizzle-orm/migrator`), with `when` as text: the column is a `bigint`,
 * which the driver hands back as a string. An empty folder is an error rather
 * than an empty list: an empty list would make an empty database look
 * migrated.
 */
export function journalMigrations(
  files: readonly { readonly folderMillis: number; readonly hash: string }[],
): Migration[] {
  if (files.length === 0) {
    throw new Error("packages/db/migrations has no migrations");
  }
  return files.map((file) => ({
    createdAt: String(file.folderMillis),
    hash: file.hash,
  }));
}
