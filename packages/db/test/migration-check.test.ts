import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";
import {
  isMigrated,
  journalMigrations,
  migrationGap,
} from "../test-support/migration-check.js";

/**
 * The comparison behind `assertMigrated` (`test-support/fixture.ts`), which
 * the api and the worker suites run before anything else. With Compose up it
 * only ever meets a migrated database, so each way of being out of date is a
 * case of its own here.
 */
const FIRST = { createdAt: "1788713608416", hash: "a".repeat(64) };
const SECOND = { createdAt: "1788713700000", hash: "b".repeat(64) };
const JOURNAL = [FIRST, SECOND];

describe("migrationGap", () => {
  it("finds nothing when the database carries exactly the folder", () => {
    const gap = migrationGap(JOURNAL, [...JOURNAL].reverse());
    expect(gap).toEqual({
      missing: [],
      unknown: [],
      changed: [],
      duplicated: [],
    });
    expect(isMigrated(gap)).toBe(true);
  });

  it("names a migration the database is missing", () => {
    const gap = migrationGap(JOURNAL, [FIRST]);
    expect(gap.missing).toEqual([SECOND.createdAt]);
    expect(isMigrated(gap)).toBe(false);
    expect(migrationGap(JOURNAL, []).missing).toEqual([
      FIRST.createdAt,
      SECOND.createdAt,
    ]);
  });

  it("names a migration the folder does not know", () => {
    const extra = { createdAt: "1799999999999", hash: "c".repeat(64) };
    const gap = migrationGap(JOURNAL, [...JOURNAL, extra]);
    expect(gap.unknown).toEqual([extra.createdAt]);
    expect(isMigrated(gap)).toBe(false);
  });

  it("names a migration whose file was edited after it was applied", () => {
    // Same `when`, another file: drizzle would not apply it again, and the
    // suites would run on the schema of the old file.
    const gap = migrationGap(JOURNAL, [
      FIRST,
      { createdAt: SECOND.createdAt, hash: "d".repeat(64) },
    ]);
    expect(gap).toEqual({
      missing: [],
      unknown: [],
      changed: [SECOND.createdAt],
      duplicated: [],
    });
    expect(isMigrated(gap)).toBe(false);
  });

  it("names a migration the database carries twice", () => {
    // Keyed by `when`, two rows of one migration would collapse into one and
    // read as "migrated".
    const gap = migrationGap(JOURNAL, [FIRST, SECOND, FIRST]);
    expect(gap).toEqual({
      missing: [],
      unknown: [],
      changed: [],
      duplicated: [FIRST.createdAt],
    });
    expect(isMigrated(gap)).toBe(false);
  });

  it("does not let a matching duplicate hide an edited file", () => {
    const edited = { createdAt: FIRST.createdAt, hash: "e".repeat(64) };
    const gap = migrationGap(JOURNAL, [edited, FIRST, SECOND]);
    expect(gap.changed).toEqual([FIRST.createdAt]);
    expect(gap.duplicated).toEqual([FIRST.createdAt]);
  });

  it("names an unknown migration once, however many rows it has", () => {
    const extra = { createdAt: "1799999999999", hash: "c".repeat(64) };
    expect(migrationGap(JOURNAL, [...JOURNAL, extra, extra]).unknown).toEqual([
      extra.createdAt,
    ]);
  });
});

describe("journalMigrations", () => {
  it("reads packages/db/migrations the way drizzle does", () => {
    const migrations = journalMigrations(
      readMigrationFiles({ migrationsFolder }),
    );
    expect(migrations[0]?.createdAt).toBe("1788713608416");
    expect(migrations[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an empty folder instead of calling every database migrated", () => {
    expect(() => journalMigrations([])).toThrow(/no migrations/);
  });
});
