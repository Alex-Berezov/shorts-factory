/**
 * Reading files for the root scripts (`scripts/*.mjs`) and the tests of the
 * root project, with one answer to "is that path gone": the gates that walk
 * a tree (check-no-search-list), that run a binary (check-compose) and that
 * read a file which may be absent (`readIfFile`) must not each decide it
 * their own way. And one listing of the files of the repository
 * (`trackedFiles`): the gates and the tests of the root project see the set
 * the hash of turbo covers, not whatever the disk holds.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * Whether `error` says there is no file at the path: it is gone (`isGone`),
 * or a file stands where the path has a directory (`ENOTDIR`) - for the
 * questions "is a file there", where a broken path is no file either. The
 * hooks of the harness keep a twin of it (`isNotFile` of
 * `.claude/hooks/lib.js`), held to this one by their selftest.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNotFile(error) {
  return isGone(error) || codeOf(error) === "ENOTDIR";
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

/**
 * How `trackedFiles` runs git: `spawnSync` unless a test hands another.
 *
 * @typedef {(command: string, args: string[], options: { cwd: string, encoding: "utf8", maxBuffer: number }) => { status: number | null, stdout: string, stderr: string, error?: Error }} SpawnGit
 */

/**
 * Room for the listing of the whole tree: the default 1 MiB is not enough
 * for long. Exported for the probe that holds the twin of `trackedFiles` in
 * the selftest of the harness to the same room.
 */
export const LISTING_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * What `trackedFiles` is asked: which paths of the listing the caller wants
 * (`keep`, every one by default), and how git runs (`spawn`, `spawnSync`
 * unless a test hands another).
 *
 * @typedef {{ keep?: (path: string) => boolean, spawn?: SpawnGit }} TrackedOptions
 */

/**
 * The files of the repository at `root` that turbo hashes - tracked by git,
 * or untracked and not ignored - as `/`-separated paths from `root`, in the
 * order git gives them. One listing of the whole tree: the scripts and the
 * tests of the root project filter it, rather than walking the disk, which
 * sees ignored files (`node_modules`, `coverage/`, build output, the bundles
 * vite writes next to a config) that no hash covers. The exclusions are the
 * standard ones of git (`--exclude-standard`): the `.gitignore` files of the
 * tree, and also `.git/info/exclude` and the global `core.excludesFile` of
 * the user, which only this machine has - a file ignored only there is left
 * out here and listed in CI, so a gate clean here can be red there.
 *
 * Only the paths `keep` takes are looked at on the disk, and only files are
 * among them: a tracked file deleted from the disk, or under a directory a
 * file now stands in place of (`isNotFile` on `stat`), and a path that is a
 * directory (a submodule, a tracked file a directory replaced) are left out;
 * any other failure to look at one (`EPERM`, `EACCES`) is thrown, not taken
 * for an absent file. A path `keep` leaves out is never looked at, so a
 * file of no interest to the caller being written or deleted meanwhile
 * cannot fail the listing. `core.fsmonitor` is off, so no daemon of the
 * user's git config answers for the tree.
 *
 * @param {string} root the top of a git work tree
 * @param {TrackedOptions} [options]
 * @returns {string[]}
 * @throws {Error} `git ls-files in <root> failed: <why>` when git cannot run
 *   or refuses (not a repository)
 */
export function trackedFiles(
  root,
  { keep = () => true, spawn = spawnSync } = {},
) {
  const listed = spawn(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: LISTING_MAX_BUFFER },
  );
  if (listed.error !== undefined) {
    throw new Error(`git ls-files in ${root} failed: ${listed.error.message}`, {
      cause: listed.error,
    });
  }
  if (listed.status !== 0) {
    throw new Error(
      `git ls-files in ${root} failed (exit ${listed.status}): ${listed.stderr.trim()}`,
    );
  }
  // `--cached --others` lists a file with a conflict once per stage.
  const paths = [...new Set(listed.stdout.split("\0"))];
  return paths.filter(
    (path) => path !== "" && keep(path) && isListedFile(join(root, path)),
  );
}

/**
 * Whether a path of the listing is a file on the disk: no file there is
 * `isNotFile` only, any other failure is thrown.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isListedFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isNotFile(error)) return false;
    throw error;
  }
}
