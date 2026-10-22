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
 * Whether a look at a path of the listing (`trackedFiles`, `readTrackedFiles`)
 * found no file there: `isNotFile`, or a directory in its place (`EISDIR` of
 * a read - a `stat` answers a directory with `isFile() === false` instead).
 * The one rule of "no file there" for a listed path, whether it is looked at
 * by its `stat` or by its read; `readIfFile` answers stricter on purpose - a
 * path through a file (`ENOTDIR`) to a file a gate must read is a fault of
 * the checkout, not an absent file.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNoListedFile(error) {
  return isNotFile(error) || codeOf(error) === "EISDIR";
}

/**
 * A file of the listing that could not be read for another reason than
 * `isNoListedFile` (`EPERM`, `EBUSY`, `EACCES`): the message and `code` of
 * the read, and `path`, the file it was made on - so a caller names the file
 * by the kind of the error, not by a `path` any error may carry (a failed
 * spawn names its command there).
 */
export class UnreadableFileError extends Error {
  /**
   * @param {string} message
   * @param {{ cause: unknown, code: string | undefined, path: string }} details
   */
  constructor(message, { cause, code, path }) {
    super(message, { cause });
    this.name = "UnreadableFileError";
    /** @type {string | undefined} */
    this.code = code;
    /** @type {string} */
    this.path = path;
  }
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
  return listedPaths(root, spawn).filter(
    (path) => keep(path) && isListedFile(join(root, path)),
  );
}

/**
 * The files of the listing of `trackedFiles` that `keep` takes, each with its
 * text - for a gate that reads every file it lists (check-no-search-list).
 * Each path is touched once, by its `readFileSync`, not by a `stat` first and
 * a read after: one call less per file, and no window between the two in
 * which a file an editor rewrites or a scanner holds answers otherwise. The
 * read decides: no file there (`isNotFile`: deleted from the disk, or under a
 * directory a file now stands in place of) and a directory (`EISDIR`, on
 * Linux and Windows alike) are left out, as `trackedFiles` leaves them; any
 * other failure (`EPERM`, `EBUSY`, `EACCES`) is thrown - a file that cannot be
 * read is not taken for an absent one.
 *
 * The tree is listed at the call; each file is read only when the caller
 * takes it from the iterator, so a scan holds one text at a time, not the
 * whole tree - and a file is judged by the disk at the moment it is read.
 *
 * @param {string} root the top of a git work tree
 * @param {TrackedOptions} [options]
 * @returns {Generator<{ path: string, text: string }, void, undefined>} in
 *   the order git gives them
 * @throws {Error} as `trackedFiles` when git cannot list the tree - at the
 *   call; for a file that cannot be read, an `UnreadableFileError` - as the
 *   iteration reaches it
 */
export function readTrackedFiles(
  root,
  { keep = () => true, spawn = spawnSync } = {},
) {
  return readEach(root, listedPaths(root, spawn).filter(keep));
}

/**
 * The texts of `paths` under `root`, one read per path as the caller takes
 * it, the paths with no file there left out (`readListedFile`).
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {Generator<{ path: string, text: string }, void, undefined>}
 */
function* readEach(root, paths) {
  for (const path of paths) {
    const text = readListedFile(join(root, path));
    if (text !== null) yield { path, text };
  }
}

/**
 * The paths of the listing of `trackedFiles`, once each, not yet looked at on
 * the disk.
 *
 * @param {string} root
 * @param {SpawnGit} spawn
 * @returns {string[]}
 */
function listedPaths(root, spawn) {
  let listed;
  try {
    listed = spawn(
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
  } catch (error) {
    // A spawn that throws instead of returning its error is the same failure
    // to list the tree, named by the root - not by the command it carries.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ls-files in ${root} failed: ${message}`, {
      cause: error,
    });
  }
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
  return [...new Set(listed.stdout.split("\0"))].filter((path) => path !== "");
}

/**
 * The text of a path of the listing, null when there is no file to read
 * (`isNoListedFile`). Any other failure is an `UnreadableFileError`, so the
 * caller names the file whatever the error says itself.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readListedFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNoListedFile(error)) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new UnreadableFileError(message, {
      cause: error,
      code: codeOf(error),
      path,
    });
  }
}

/**
 * Whether a path of the listing is a file on the disk: no file there is
 * `isNoListedFile` (a directory is `isFile() === false`), any other failure
 * is thrown.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isListedFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isNoListedFile(error)) return false;
    throw error;
  }
}
