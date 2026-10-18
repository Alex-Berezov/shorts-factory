#!/usr/bin/env node
/**
 * Gate: YouTube Data API `search.list` (100 quota units per call) is banned project-wide.
 * Scans source files under apps/, packages/, scripts/ and test/ for any of its
 * forms.
 *
 * Usage: `node scripts/check-no-search-list.mjs [root]` - the repository root
 * by default (`scripts/lib/paths.mjs`).
 * Exit 1 with file:line of every hit; exit 2 when the scan itself failed - a
 * directory of the list is missing or cannot be read, or there was no file
 * to scan at all: a gate that saw nothing has proven nothing. A file or a
 * directory that is gone between its listing and its reading (`ENOENT`,
 * `isGone` of `scripts/lib/files.mjs`) is no longer in the tree and is not
 * scanned; any other failure to read is exit 2. The bundles vite writes and
 * removes next to a config while tests run (`VITE_BUNDLE`) are skipped by
 * their name, a file of the listing only (its entry type, no `statSync`): on
 * Windows one being deleted answers `EPERM`, which is not "gone"; a directory
 * of that name is walked. Exit 0 when clean, with the number of files scanned.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isGone } from "./lib/files.mjs";
import { repoRoot } from "./lib/paths.mjs";

const ROOT =
  process.argv[2] === undefined ? repoRoot : resolve(process.argv[2]);
const SCAN = ["apps", "packages", "scripts", "test"];
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);
const BANNED = /search\.list|youtube\.search\s*\(|\/youtube\/v3\/search/;
const SELF = /check-no-search-list|no-search-list|NEVER|never|запрещ/;
/** A bundle of a vite config (`vitest.config.ts.timestamp-<ms>-<hash>.mjs`), ignored by git. */
const VITE_BUNDLE = /\.timestamp-\d+-[\w-]+\.mjs$/;

/**
 * Stops the gate on a scan that could not be completed.
 *
 * @param {string} path what could not be read
 * @param {unknown} error why
 * @returns {never}
 */
function scanFailed(path, error) {
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`no-search-list: cannot scan ${path}: ${cause}`);
  process.exit(2);
}

/**
 * Every source file under `dir`, depth first. `listed` - `dir` came from the
 * listing of its parent, so its being gone is not a failure of the scan.
 *
 * @param {string} dir
 * @param {boolean} listed
 * @returns {Generator<string>}
 */
function* walk(dir, listed) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (listed && isGone(error)) return;
    scanFailed(dir, error);
  }
  for (const entry of entries) {
    const name = entry.name;
    if (SKIP_DIRS.has(name)) continue;
    if (entry.isFile() && VITE_BUNDLE.test(name)) continue;
    const p = join(dir, name);
    let isDirectory;
    try {
      isDirectory = statSync(p).isDirectory();
    } catch (error) {
      if (isGone(error)) continue;
      scanFailed(p, error);
    }
    if (isDirectory) yield* walk(p, true);
    else if (EXT.has(name.slice(name.lastIndexOf(".")))) yield p;
  }
}

/** @type {string[]} */
const hits = [];
let scanned = 0;
for (const top of SCAN) {
  for (const file of walk(join(ROOT, top), false)) {
    if (file.endsWith("check-no-search-list.mjs")) continue; // this gate names the banned call itself
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isGone(error)) continue;
      scanFailed(file, error);
    }
    scanned += 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (BANNED.test(line) && !SELF.test(line))
        hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
}

if (hits.length) {
  console.error(
    "YouTube search endpoint is banned (100 units/call). Use playlistItems.list + videos.list.",
  ); // no-search-list gate
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
if (scanned === 0) {
  console.error(
    `no-search-list: no source file under ${SCAN.join(", ")} of ${ROOT}`,
  );
  process.exit(2);
}
console.log(`no-search-list: clean (${scanned} files)`);
