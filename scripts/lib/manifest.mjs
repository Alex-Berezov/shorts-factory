/**
 * Package manifests and package directories of the workspace for the root
 * scripts (`scripts/*.mjs`): one checked shape of a `package.json`, by the
 * fields a script reads. The scripts depend on `node:*` and `./lib` only, so
 * the shape is checked by hand here; the tests of the root project read
 * manifests through the Zod schema of `test/repo-files.ts` (`ManifestSchema`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "./paths.mjs";

/**
 * The fields of a `package.json` the root scripts read.
 *
 * @typedef {object} PackageManifest
 * @property {string} name
 * @property {Record<string, string>} dependencies empty when the file has none
 */

/**
 * Whether `value` is a plain object (not null, not an array).
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A parsed `package.json` checked for the fields the scripts read; any other
 * shape throws, naming the field and the file.
 *
 * @param {unknown} value
 * @param {string} where the file, for the message
 * @returns {PackageManifest}
 */
export function parseManifest(value, where) {
  if (!isRecord(value)) throw new Error(`${where}: not a JSON object`);
  const { name, dependencies } = value;
  if (typeof name !== "string") {
    throw new Error(`${where}: "name" is not a string`);
  }
  if (dependencies === undefined) return { name, dependencies: {} };
  if (
    !isRecord(dependencies) ||
    !Object.values(dependencies).every((range) => typeof range === "string")
  ) {
    throw new Error(`${where}: "dependencies" is not an object of strings`);
  }
  return {
    name,
    dependencies: /** @type {Record<string, string>} */ ({ ...dependencies }),
  };
}

/**
 * The manifest of the package at `dir` of the repository (`apps/api`).
 *
 * @param {string} dir relative to the repository root
 * @returns {PackageManifest}
 */
export function readManifestFields(dir) {
  const file = `${dir}/package.json`;
  return parseManifest(
    JSON.parse(readFileSync(join(repoRoot, file), "utf8")),
    file,
  );
}

/**
 * The package globs of a `pnpm-workspace.yaml`: the items of the block list
 * under its top-level key `packages:`, in order. The other keys of the file
 * (`onlyBuiltDependencies`, `catalog`, ...) are not read. A file without
 * that list (no key, or a flow list `packages: [...]`), a line under the key
 * that is not a list item, an empty list and a glob not of the form `dir/*`
 * throw instead of being skipped.
 *
 * @param {string} yaml the text of the file
 * @returns {string[]}
 */
export function workspaceGlobs(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (start === -1) {
    throw new Error("pnpm-workspace.yaml has no block list under packages:");
  }
  /** @type {string[]} */
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    // The next top-level key ends the list; an item may sit at column 0.
    if (!/^\s/.test(line) && !line.startsWith("-")) break;
    const item = /^\s*-\s+(?:"([^"]*)"|'([^']*)'|([^\s"'#]+))\s*(?:#.*)?$/.exec(
      line,
    );
    if (item === null) {
      throw new Error(
        `pnpm-workspace.yaml: "${line.trim()}" under packages: is not a list item`,
      );
    }
    const glob = item[1] ?? item[2] ?? item[3] ?? "";
    if (!/^[\w/-]+\/\*$/.test(glob)) {
      throw new Error(`workspace glob "${glob}" is not of the form dir/*`);
    }
    globs.push(glob);
  }
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml lists no package glob");
  }
  return globs;
}

/**
 * Package directories of the workspace under `root`, from the globs of its
 * `pnpm-workspace.yaml` (`workspaceGlobs`), as `/`-separated paths from
 * `root`, sorted: the directories of each glob that hold a `package.json`.
 * The one reading of the workspace for the scripts and the tests of the root
 * project (the tests take it from here, not through `test/repo-files.ts`).
 *
 * @param {string} [root] the repository root by default
 * @returns {string[]}
 */
export function workspaceDirs(root = repoRoot) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  /** @type {string[]} */
  const dirs = [];
  for (const glob of workspaceGlobs(yaml)) {
    const parent = join(root, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dir = join(parent, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, "package.json"))) {
        dirs.push(relative(root, dir).replaceAll("\\", "/"));
      }
    }
  }
  return dirs.sort();
}
