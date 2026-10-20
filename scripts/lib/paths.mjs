/**
 * The repository root for the root scripts (`scripts/*.mjs`) and the tests of
 * the root project (`test/`). One place for the arithmetic, so a script that
 * moves does not keep a stale copy of it; the packages take theirs from
 * `@sf/config/paths`, and neither side imports the other. Next to it
 * `isEntry`, the entry guard of a root script that its tests import as a
 * module: it compares the module's path with the path node was started
 * with, the same arithmetic of paths. And the forms paths are compared in:
 * `fromRoot` (from the root, `/` between the parts) and `nameOn` (without
 * the case on Windows).
 *
 * Through `fileURLToPath`, never `URL.pathname`: the pathname keeps `%20` for
 * a space and the percent escapes of every non-ASCII letter, so a checkout
 * under such a path would resolve to a directory that does not exist.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf } from "./files.mjs";

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

/**
 * The canonical path of `path`: the native realpath, the one the compose gate
 * and `isEntry` both compare paths with. On Windows it gives the case of every
 * letter as the disk has it, while the realpath of node's own JS keeps the
 * case it was given (`d:\...` stays `d:\...`, and `import.meta.url` says
 * `D:`); it also follows a junction, a `subst` drive or a symlink.
 *
 * @param {string} path
 * @param {(path: string) => string} [resolvePath] the realpath; the native one
 *   unless a test hands another
 * @returns {string}
 * @throws {Error} `cannot resolve <path>`, the failure in `cause`
 */
export function canonical(path, resolvePath = realpathSync.native) {
  try {
    return resolvePath(path);
  } catch (error) {
    throw new Error(`cannot resolve ${path}`, { cause: error });
  }
}

/**
 * `path` from `root`, with `/` between its parts on every system: the form
 * the masks of a gate's `when` and the lists of the compose rules name a file
 * of the repository in (`infra/docker-compose.yml`).
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function fromRoot(root, path) {
  return relative(root, path).split(sep).join("/");
}

/**
 * `name` - a path or the name of a variable of the environment - in the form
 * `platform` compares it in: Windows takes both without their case
 * (`Infra\compose.yaml` is `infra\compose.yaml`, `compose_file` is
 * `COMPOSE_FILE`), so there it is upper-cased; elsewhere it is as it is.
 * Compare a form with a form - a name in capitals is its own - never a form
 * with a name as written.
 *
 * @param {string} name
 * @param {string} [platform] this one by default
 * @returns {string}
 */
export function nameOn(name, platform = process.platform) {
  return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * What `isFileAt` asks of the disk: the entry at `path`, undefined if there is
 * none; throws as `statSync` does for any other failure.
 *
 * @typedef {(path: string) => { isFile(): boolean } | undefined} StatOf
 */

/** @type {StatOf} */
const statOf = (path) => statSync(path, { throwIfNoEntry: false });

/**
 * Whether `path` names a file on disk. A missing path, or one with a file
 * where a directory should be (ENOTDIR), is not one; any other failure of
 * `stat` is thrown with the path. Unlike `readIfFile` (`files.mjs`), which
 * throws on ENOTDIR: a broken path to a file a gate reads is a fault, while an
 * `argv[1]` through a file names no script and so is not the entry.
 *
 * @param {string} path
 * @param {StatOf} stat
 * @returns {boolean}
 * @throws {Error} `cannot stat <path>`, the failure in `cause`
 */
function isFileAt(path, stat) {
  try {
    return stat(path)?.isFile() ?? false;
  } catch (error) {
    if (codeOf(error) === "ENOTDIR") return false;
    throw new Error(`cannot stat ${path}`, { cause: error });
  }
}

/**
 * Whether the module at `metaUrl` is the script node was started with - the
 * guard of a root script that is a module of its tests as well. Node resolves
 * symlinks in `import.meta.url` but leaves `argv[1]` as written, so both sides
 * go through `canonical`. `false` means another script was started: no
 * `argv[1]`, an `argv[1]` that names no file (`-` of a script read from stdin,
 * a wrapper's own argument, a path through a file - ENOTDIR, where
 * `readIfFile` throws), or another file. Fail-closed otherwise: an
 * `argv[1]` that cannot be read (`stat` fails other than with ENOENT or
 * ENOTDIR, say EACCES), a file that exists but cannot be resolved, or a module
 * that cannot, throws with its path rather than answering "not the entry" - a
 * gate whose guard said so there would exit 0 having checked nothing.
 *
 * @param {string} metaUrl `import.meta.url` of the module
 * @param {string | undefined} entry `process.argv[1]`
 * @param {(path: string) => string} [resolvePath] the realpath, as `canonical`
 *   takes it
 * @param {StatOf} [stat] how `argv[1]` is looked up on disk
 * @returns {boolean}
 * @throws {Error} `cannot stat <path>` or `cannot resolve <path>`, the failure
 *   in `cause`
 */
export function isEntry(metaUrl, entry, resolvePath, stat = statOf) {
  if (entry === undefined || entry === "" || !isFileAt(entry, stat)) {
    return false;
  }
  return (
    canonical(fileURLToPath(metaUrl), resolvePath) ===
    canonical(entry, resolvePath)
  );
}
