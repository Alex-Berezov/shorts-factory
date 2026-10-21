#!/usr/bin/env node
// The call by name: search.list of YouTube (no-search-list: allowed).
/**
 * Gate: the search call of the YouTube Data API is banned: 100 quota units
 * per call, banned project-wide.
 * Scans every source file of the repository (`isSource` of
 * `scripts/lib/search-list.mjs`), in whatever directory, for any of its
 * forms. The files are the ones git lists (`trackedFiles` of
 * `scripts/lib/files.mjs`: tracked, or untracked and not ignored), the set
 * the hash of turbo covers; build output, `node_modules` and the bundles
 * vite writes next to a config are ignored files and not among them.
 *
 * The rule is the one of `scripts/lib/search-list.mjs`, which the standards
 * hook (S04) holds as well: a line that has to name the call is a line
 * comment (`//`) carrying the mark `no-search-list: allowed` (`ALLOWED`);
 * the mark after code or on a line of a block comment lets nothing through,
 * and no file - this one included - is left out.
 *
 * Usage: `node scripts/check-no-search-list.mjs [root]` - the repository root
 * by default (`scripts/lib/paths.mjs`).
 * Exit 1 with file:line of every hit; exit 2 when the scan itself failed -
 * git could not list the tree (not started, not a repository), one of
 * apps/, packages/, scripts/ and test/ has no source file, or a listed file
 * cannot be read: a gate that saw nothing has proven nothing. A file gone
 * between the listing and its reading (`ENOENT`, `isGone` of
 * `scripts/lib/files.mjs`) is no longer in the tree and is not scanned; any
 * other failure to read is exit 2. Exit 0 when clean, with the number of
 * files scanned.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isGone, trackedFiles } from "./lib/files.mjs";
import { repoRoot } from "./lib/paths.mjs";
import { breaksRule, isSource } from "./lib/search-list.mjs";

const ROOT =
  process.argv[2] === undefined ? repoRoot : resolve(process.argv[2]);
/** The directories that must hold a source file: an empty one is a broken checkout. */
const REQUIRED = ["apps", "packages", "scripts", "test"];

/**
 * Stops the gate on a scan that could not be completed.
 *
 * @param {string} what what could not be read
 * @param {unknown} error why
 * @returns {never}
 */
function scanFailed(what, error) {
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`no-search-list: cannot scan ${what}: ${cause}`);
  process.exit(2);
}

/** @type {string[]} */
let files;
try {
  // Only the sources are looked at on the disk (`keep`).
  files = trackedFiles(ROOT, { keep: isSource });
} catch (error) {
  scanFailed(ROOT, error);
}

const empty = REQUIRED.filter(
  (dir) => !files.some((path) => path.startsWith(`${dir}/`)),
);
if (empty.length > 0) {
  console.error(
    `no-search-list: no source file under ${empty.join(", ")} of ${ROOT}`,
  );
  process.exit(2);
}

/** @type {string[]} */
const hits = [];
let scanned = 0;
for (const path of files) {
  const file = join(ROOT, path);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isGone(error)) continue;
    scanFailed(file, error);
  }
  scanned += 1;
  text.split(/\r?\n/).forEach((line, i) => {
    if (breaksRule(line)) {
      hits.push(`${path}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length) {
  console.error(
    "YouTube search endpoint is banned (100 units/call). Use playlistItems.list + videos.list.",
  );
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
if (scanned === 0) {
  console.error(`no-search-list: every listed file of ${ROOT} was gone`);
  process.exit(2);
}
console.log(`no-search-list: clean (${scanned} files)`);
