/**
 * The `doc` field of a task of docs/tasks/tasks.json: the document that holds
 * the section of the task, as a path from `docs/` (`30_E0_TASKS.md`,
 * `TECH_DEBT.md`). Every reader adds the `docs/` itself - `next` and `start`
 * of `scripts/tasks.mjs` print `docs/<doc>`, docs/00_STATUS.md links
 * `docs/<doc>` from the root - so a value that already starts with `docs/`
 * points at `docs/docs/...`, a file that is not there. `add` and `set` refuse
 * such a value before writing it, and `render --check` refuses a tracker
 * where any task names a document that is not on disk.
 *
 * The value is held to what every reader on every system takes the same way:
 * `/`-separated, no `.` or `..` segment and not absolute - so it cannot leave
 * `docs/` - and every segment with the case it has on disk. A file system that
 * ignores case (NTFS, the default of macOS) would find `tech_debt.md` or
 * `adr\README.md` where the Linux of CI and a link in a browser find nothing,
 * so the names are compared with those `readdirSync` gives, one directory at
 * a time, rather than asked of `stat`.
 */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codeOf } from "./files.mjs";

/**
 * The names in `dir` as the disk has them; none for a directory that is not
 * there or is a file (ENOENT, ENOTDIR). Any other failure is thrown.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function namesIn(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Why `doc` cannot be the `doc` of a task, undefined if it can.
 *
 * @param {unknown} doc the value as given, or as the tracker holds it
 * @param {string} docsDir the absolute path of `docs/`
 * @returns {string | undefined}
 */
export function docProblem(doc, docsDir) {
  if (typeof doc !== "string") return "doc is missing";
  if (doc.trim() === "") return "doc is empty";
  if (/^\.{0,2}\/?docs[\\/]/.test(doc)) {
    return `doc "${doc}" starts with docs/: the tracker adds docs/ itself, give "${doc.replace(/^\.{0,2}\/?docs[\\/]/, "")}"`;
  }
  if (isAbsolute(doc) || /^[A-Za-z]:/.test(doc) || doc.startsWith("/")) {
    return `doc "${doc}" is an absolute path: give a path from docs/`;
  }
  if (doc.includes("\\")) {
    return `doc "${doc}" has a backslash: separate the directories with /`;
  }
  const segments = doc.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `doc "${doc}" has a . or .. segment: give a path from docs/ that stays in it`;
  }
  let path = docsDir;
  for (const segment of segments) {
    const names = namesIn(path);
    if (!names.includes(segment)) {
      const other = names.find(
        (name) => name.toLowerCase() === segment.toLowerCase(),
      );
      return other === undefined
        ? `doc "${doc}" names no file: docs/${doc} is not on disk`
        : `doc "${doc}" names no file: "${segment}" is "${other}" on disk, and the case counts`;
    }
    path = join(path, segment);
  }
  return statSync(path).isFile()
    ? undefined
    : `doc "${doc}" names no file: docs/${doc} is not a file`;
}

/**
 * The tasks whose `doc` cannot be theirs, one line each (`E0-12L: doc ...`);
 * a task without a `doc` at all is one of them.
 *
 * @param {ReadonlyArray<{ id: string, doc?: unknown }>} tasks
 * @param {string} docsDir the absolute path of `docs/`
 * @returns {string[]}
 */
export function badDocs(tasks, docsDir) {
  /** @type {string[]} */
  const bad = [];
  for (const task of tasks) {
    const problem = docProblem(task.doc, docsDir);
    if (problem !== undefined) bad.push(`${task.id}: ${problem}`);
  }
  return bad;
}
