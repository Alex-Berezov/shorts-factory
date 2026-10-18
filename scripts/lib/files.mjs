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
 * value. The one reading of it for the root scripts: `isGone` below and
 * `isFileAt` (`scripts/lib/paths.mjs`, the step of `isEntry`) take it from
 * here.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function codeOf(error) {
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
 * directory); any other failure to read is thrown, a path with a file where a
 * directory should be (ENOTDIR) included: a broken path to a file the gate
 * must read is a fault of the checkout, not an absent file. `isEntry` answers
 * the other way for its `argv[1]`, since there a path through a file names
 * no script.
 *
 * It is the `read` the compose gate and the tests of the root project give
 * `checkCompose` (`scripts/compose-rules.mjs`): the `.dockerignore` of each
 * build (rule 11) and the root `.env.test` (rule 12).
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
