import { describe, expect, it } from "vitest";
import { LOOKUP, enumerationViolations } from "./enumeration.js";
import {
  parseRepoYaml,
  readRepoFile,
  readRepoYaml,
  repoFileExists,
  repoFilesUnder,
  repoListing,
} from "./repo-files.js";

/**
 * The one listing of the files of the repository for the tests of the root
 * project (`test/repo-files.ts`): asked of git once, filtered by directory,
 * failing with its reason when git does - and the lock that keeps it the one
 * way a test of the root project lists or looks up a file of the repository.
 */

describe("repoListing", () => {
  const counted = (files: string[]) => {
    let calls = 0;
    const listing = repoListing(() => {
      calls += 1;
      return files;
    });
    return { listing, calls: () => calls };
  };

  it("asks for the files once, whatever is asked after", () => {
    const { listing, calls } = counted(["apps/api/a.ts", "docs/x.md"]);

    expect(listing.under("apps")).toEqual(["apps/api/a.ts"]);
    expect(listing.under(".")).toEqual(["apps/api/a.ts", "docs/x.md"]);
    expect(listing.exists("docs/x.md")).toBe(true);
    expect(calls()).toBe(1);
  });

  it("asks for nothing until a question comes", () => {
    const { calls } = counted([]);

    expect(calls()).toBe(0);
  });

  it("takes a directory whole, not a sibling that starts with its name", () => {
    const { listing } = counted([
      "apps/api/src/a.ts",
      "apps/api2/src/b.ts",
      "apps/api.md",
    ]);

    expect(listing.under("apps/api")).toEqual(["apps/api/src/a.ts"]);
    expect(listing.under("apps/api/")).toEqual(["apps/api/src/a.ts"]);
  });

  it("answers for a file of the listing, not for a directory or a prefix", () => {
    const { listing } = counted(["apps/api/package.json"]);

    expect(listing.exists("apps/api/package.json")).toBe(true);
    expect(listing.exists("apps/api")).toBe(false);
    expect(listing.exists("apps/api/package")).toBe(false);
  });

  it("throws the failure of the listing to the question, and asks again", () => {
    let calls = 0;
    const listing = repoListing(() => {
      calls += 1;
      throw new Error(
        "git ls-files in /x failed (exit 128): not a git repository",
      );
    });

    expect(() => listing.under(".")).toThrow("not a git repository");
    expect(() => listing.exists("a")).toThrow("not a git repository");
    expect(calls).toBe(2);
  });

  it("refuses a listing that is not a list of paths", () => {
    const listing = repoListing(() => ["a", ""]);

    expect(() => listing.under(".")).toThrow(
      "String must contain at least 1 character(s)",
    );
  });
});

describe("the listing of this repository", () => {
  it("holds the files the hash covers and nothing ignored", () => {
    expect(repoFileExists("pnpm-workspace.yaml")).toBe(true);
    expect(repoFileExists("test/repo-files.ts")).toBe(true);
    expect(repoFilesUnder("node_modules")).toEqual([]);
    expect(repoFilesUnder("test")).toContain("test/repo-files.test.ts");
  });
});

/** A Compose file of the repository that writes the `<<` key. */
const MERGING_COMPOSE = "infra/docker-compose.app.yml";

/** Three levels of ten aliases: past the limit of the reading. */
const ALIAS_BOMB = [
  "a: &a [x, x, x, x, x, x, x, x, x, x]",
  "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
  "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
  "",
].join("\n");

describe("parseRepoYaml and readRepoYaml", () => {
  const MERGED = "base: &base\n  x: 1\nc:\n  <<: *base\n  y: 2\n";

  it("expands the << key with merge", () => {
    expect(parseRepoYaml(MERGED, "m.yml", { merge: true })).toEqual({
      base: { x: 1 },
      c: { x: 1, y: 2 },
    });
  });

  it("keeps << as a key without merge", () => {
    expect(parseRepoYaml(MERGED, "m.yml")).toEqual({
      base: { x: 1 },
      c: { "<<": { x: 1 }, y: 2 },
    });
  });

  it.each([
    ["an empty text", "", {}, "no YAML document"],
    ["two documents", "a: 1\n---\nb: 2\n", {}, "2 YAML documents"],
    ["a warning of the parser", "a: !nope x\n", {}, "TAG_RESOLVE_FAILED"],
    ["aliases past the limit", ALIAS_BOMB, {}, "aliases past the limit"],
    [
      "a value the parser cannot build",
      "a: 1\n<<: 1\n",
      { merge: true },
      "Merge sources must be maps",
    ],
  ])("refuses %s, naming the file first", (_what, text, options, reason) => {
    const read = () => parseRepoYaml(text, "x/named.yml", options);

    expect(read).toThrow(/^x\/named\.yml is not read cleanly: /);
    expect(read).toThrow(reason);
  });

  it("reads a file of the repository as parseRepoYaml reads its text", () => {
    const options = { merge: true };

    expect(readRepoYaml(MERGING_COMPOSE, options)).toEqual(
      parseRepoYaml(readRepoFile(MERGING_COMPOSE), MERGING_COMPOSE, options),
    );
    expect(readRepoFile(MERGING_COMPOSE)).toContain("<<:");
    expect(
      JSON.stringify(readRepoYaml(MERGING_COMPOSE, options)),
    ).not.toContain("<<");
  });
});

/** The one module that lists the files of the repository. */
const LISTING_MODULE = "test/repo-files.ts";

/**
 * The tests that look a path of the repository up on the disk on purpose,
 * each with its reason: what they check is the disk itself. Only the lookup
 * is let off: a disk check lists no directory either.
 */
const DISK_CHECKS: Record<string, string> = {
  "test/paths.test.ts":
    "checks repoRoot itself - the listing is taken from that directory, so it cannot vouch for it",
};

describe("listing through test/repo-files.ts only", () => {
  it.each([
    ['import { readdirSync } from "node:fs";', "imports readdirSync"],
    ['import { readdir as list } from "node:fs/promises";', "imports readdir"],
    ['import { globSync } from "fs";', "imports globSync"],
    [
      'import * as fs from "node:fs";\nfs.opendirSync(dir);',
      "calls fs.opendirSync",
    ],
    [
      'import fs from "node:fs";\nconst names = fs.readdirSync(dir);',
      "calls fs.readdirSync",
    ],
    [
      'import { existsSync } from "node:fs";\nexistsSync(join(repoRoot, "x"));',
      "existsSync of a path under repoRoot",
    ],
    [
      'import { statSync } from "node:fs";\nstatSync(`${repoRoot}/x`);',
      "statSync of a path under repoRoot",
    ],
    [
      'import { existsSync } from "node:fs";\nconst file = join(repoRoot, "x");\nexistsSync(file);',
      "existsSync of a path under repoRoot",
    ],
    [
      'import { existsSync as e } from "node:fs";\ne(join(repoRoot, "x"));',
      "existsSync of a path under repoRoot",
    ],
    [
      'const { statSync: look } = require("node:fs");\nlook(join(repoRoot, "x"));',
      "statSync of a path under repoRoot",
    ],
    [
      'import fs from "node:fs";\nconst { readdirSync } = fs;',
      "takes readdirSync",
    ],
    ['const { readdirSync: list } = require("node:fs");', "takes readdirSync"],
    ['const { opendir } = await import("node:fs/promises");', "takes opendir"],
    ['require("node:fs").readdirSync(dir);', "calls require"],
    ['(await import("node:fs")).readdirSync(dir);', "calls (await import"],
    [
      'import fs from "node:fs";\nawait fs.promises.readdir(dir);',
      "calls fs.promises.readdir",
    ],
    [
      'import { promises } from "node:fs";\nawait promises.readdir(dir);',
      "calls promises.readdir",
    ],
    [
      'import { promises as p } from "fs";\nconst q = p;\nawait q.opendir(dir);',
      "calls q.opendir",
    ],
    [
      'const fs = require("fs");\nconst names = fs["readdirSync"](dir);',
      'calls fs["readdirSync"]',
    ],
    [
      'const { promises } = await import("node:fs");\nawait promises.glob("*");',
      "calls promises.glob",
    ],
  ])("refuses %j", (text, problem) => {
    expect(enumerationViolations("test/x.test.ts", text)).toEqual([
      expect.stringContaining(problem),
    ]);
  });

  it.each([
    'import { existsSync } from "node:fs";\nexistsSync(join(tmpdir(), "x"));',
    'const preload = "fs.readdirSync = () => []";',
    "// readdirSync(repoRoot) in a comment",
    'import { readFileSync } from "node:fs";\nreadFileSync(join(repoRoot, "x"));',
    'const { readFileSync } = require("node:fs");',
    'import { readdir } from "./local.js";\nreaddir(dir);',
    "const list = { readdirSync: () => [] };\nlist.readdirSync();",
  ])("passes %j", (text) => {
    expect(enumerationViolations("test/x.test.ts", text)).toEqual([]);
  });

  it("holds every file of the root project, save the listing and the disk checks", () => {
    const files = repoFilesUnder("test").filter((path) =>
      /\.[cm]?tsx?$/.test(path),
    );
    expect(files.length).toBeGreaterThan(10);
    // A disk check may look its paths up; it lists no directory either.
    const problems = files
      .filter((path) => path !== LISTING_MODULE)
      .flatMap((path) =>
        enumerationViolations(path, readRepoFile(path)).filter(
          (problem) =>
            !(Object.hasOwn(DISK_CHECKS, path) && problem.endsWith(LOOKUP)),
        ),
      );

    expect(problems).toEqual([]);
  });

  it("names only disk checks that still look at the disk", () => {
    for (const path of Object.keys(DISK_CHECKS)) {
      expect(
        enumerationViolations(path, readRepoFile(path)).filter((problem) =>
          problem.endsWith(LOOKUP),
        ),
        path,
      ).not.toEqual([]);
    }
  });
});
