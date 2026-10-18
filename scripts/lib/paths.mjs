/**
 * The repository root for the root scripts (`scripts/*.mjs`) and the tests of
 * the root project (`test/`). One place for the arithmetic, so a script that
 * moves does not keep a stale copy of it; the packages take theirs from
 * `@sf/config/paths`, and neither side imports the other.
 *
 * Through `fileURLToPath`, never `URL.pathname`: the pathname keeps `%20` for
 * a space and the percent escapes of every non-ASCII letter, so a checkout
 * under such a path would resolve to a directory that does not exist.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory `up` levels above the directory of the module at `moduleUrl`.
 *
 * @param {string} moduleUrl `import.meta.url` of a module
 * @param {number} up how many directories to go up from the module's own
 * @returns {string} an absolute path without a trailing separator
 */
export function rootOf(moduleUrl, up) {
  const parts = Array.from({ length: up }, () => "..");
  return resolve(dirname(fileURLToPath(moduleUrl)), ...parts);
}

/** The repository root: two levels above `scripts/lib/`. */
export const repoRoot = rootOf(import.meta.url, 2);
