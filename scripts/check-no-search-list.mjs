#!/usr/bin/env node
/**
 * Gate: YouTube Data API `search.list` (100 quota units per call) is banned project-wide.
 * Scans source files under apps/, packages/ and scripts/ for any of its forms.
 * Exit 1 with file:line on the first hit; exit 0 when clean.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const SCAN = ["apps", "packages", "scripts"];
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

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(name.slice(name.lastIndexOf(".")))) yield p;
  }
}

const hits = [];
for (const top of SCAN) {
  let dir;
  try {
    dir = join(ROOT, top);
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    if (file.endsWith("check-no-search-list.mjs")) continue; // this gate names the banned call itself
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
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
console.log("no-search-list: clean");
