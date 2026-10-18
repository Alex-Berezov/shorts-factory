/**
 * Reading files for the root scripts (`scripts/*.mjs`) and the tests of the
 * root project, with one answer to "is that path gone": the gates that walk
 * a tree (check-no-search-list), that run a binary (check-compose) and that
 * read a file which may be absent (`readIfFile`) must not each decide it
 * their own way.
 */
import { readFileSync, statSync } from "node:fs";

/**
 * The `code` of a failed system call (`ENOENT`, ...), undefined for any other
 * value.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
function codeOf(error) {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Whether `error` says the path is gone: `ENOENT`, nothing else. `EPERM`,
 * `EBUSY` or `EACCES` say the path cannot be read, not that it is not there -
 * a second look through `existsSync` cannot tell them apart either, since it
 * answers `false` on any failure of its own.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isGone(error) {
  return codeOf(error) === "ENOENT";
}

/**
 * Contents of a file, null if there is no file at `path` (nothing there, or a
 * directory); any other failure to read is thrown. The reader the compose
 * gate and the tests of the root project give `checkBuildIgnores`
 * (`scripts/compose-rules.mjs`).
 *
 * @param {string} path
 * @returns {string | null}
 */
export function readIfFile(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}
