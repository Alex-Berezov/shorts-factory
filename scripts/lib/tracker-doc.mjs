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
 *
 * A task whose `doc` is not `DEFAULT_DOC` (docs/00_STATUS.md, which links
 * itself) also owns one section `### <id>. <title>` of that document, and the
 * link of docs/00_STATUS.md - `docs/<doc>#<slug(id, title)>` - leads to it
 * only while the anchor of the heading is the slug of the id and the title
 * the tracker holds, by the rule GitHub makes anchors with. The id ends at the
 * dot: `### E0-12A.` is not the section of `E0-12AA`; a line in a fenced block
 * of code is not a heading (`markdown.mjs`). A heading with markup that moves
 * its anchor, or whose anchor another heading of the document has too, is
 * refused: the link could miss it. `sectionProblem` and `badSections` hold
 * the tracker to that.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codeOf } from "./files.mjs";
import { proseLines } from "./markdown.mjs";

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

/** The `doc` of a task that names no document of its own; `add` gives it by default. */
export const DEFAULT_DOC = "00_STATUS.md";

/**
 * The anchor GitHub gives a heading (github-slugger, which VS Code follows
 * too): the text lowercased, everything but letters, digits, `-`, `_` and
 * the blank cut out, every blank made a `-` - one by one, so a ` - ` between
 * words is `---` and a cut `—` between two blanks leaves `--`. A rule of our
 * own would hold the tracker to itself and let a link miss its section.
 *
 * @param {string} headingText the text of the heading after `### `
 * @returns {string}
 */
function anchorOf(headingText) {
  return headingText
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\-_ ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * The anchor of the section `### <id>. <title>`.
 *
 * @param {string} id
 * @param {string} title
 * @returns {string}
 */
export function slug(id, title) {
  return anchorOf(`${id}. ${title}`);
}

/**
 * The line of the section of a task, `### <id>. <title>`; with an empty
 * title, the start every line of that section has.
 *
 * @param {string} id
 * @param {string} title
 * @returns {string}
 */
export function sectionHeading(id, title) {
  return `### ${id}. ${title}`;
}

/**
 * The markup in the text of a heading that changes its anchor in a way
 * `anchorOf` does not work out - the anchor is made of the text as rendered,
 * and the rule here reads the source: emphasis (two runs of `*` - one run,
 * `scripts/**`, has nothing to pair with and stays as it is; `_` at the edge
 * of a word - one inside a word, `COMPOSE_FILE`, is a letter), inline HTML (`<`), a
 * link (`[`), a closing sequence of `#` and an HTML entity (`&amp;`,
 * `&#x27;` - rendered as the character it stands for). Such a heading is
 * refused rather than rendered here, so a link that may miss its section is never green.
 *
 * @param {string} text the text of the heading after `### `
 * @returns {string | undefined} the markup found, undefined for none
 */
function markupIn(text) {
  if (/[ \t]#+$/.test(text)) return "a closing sequence of #";
  if ((text.match(/\*+/g) ?? []).length > 1) return "emphasis (*)";
  if (/(?:^|[^\p{L}\p{N}])_|_(?:[^\p{L}\p{N}]|$)/u.test(text)) {
    return "emphasis (_ at the edge of a word)";
  }
  if (text.includes("<")) return "inline HTML (<)";
  if (text.includes("[")) return "a link ([)";
  if (/&\w+;|&#/.test(text)) return "an HTML entity (&...;)";
  return undefined;
}

/**
 * An ATX heading of any level: up to three blanks, one to six `#`, the text
 * after a blank (a closing sequence of `#` is not part of it).
 */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/**
 * How to set a section problem right, by the command that met it: `add`
 * before the task is in the tracker, `set` on a task that is, `check` for
 * `render --check`, which names a task already written.
 *
 * @typedef {"add" | "set" | "check"} Command
 */

/**
 * Why the document of `task` does not hold its section, undefined if it does
 * (and for a task of `DEFAULT_DOC`, which needs none); the reason ends with
 * what to do about it, as `command` can do it.
 *
 * @param {{ id: string, title: string, doc: string }} task
 * @param {string} docsDir the absolute path of `docs/`
 * @param {Command} command
 * @param {(path: string) => string[]} [linesOf] the prose lines of a file; the disk by default
 * @returns {string | undefined}
 */
export function sectionProblem(
  task,
  docsDir,
  command,
  linesOf = (path) => proseLines(readFileSync(path, "utf8")),
) {
  if (task.doc === DEFAULT_DOC) return undefined;
  const prefix = sectionHeading(task.id, "");
  const wanted = `"${sectionHeading(task.id, task.title)}"`;
  const lines = linesOf(join(docsDir, task.doc));
  const headings = lines.filter((line) => line.startsWith(prefix));
  const [heading] = headings;
  if (heading === undefined) {
    const fix = {
      add: `write the section ${wanted} in docs/${task.doc} first, then add the task`,
      set: `write the section ${wanted} in docs/${task.doc} first, or give --doc the document that has it`,
      check: `write the section ${wanted} in docs/${task.doc}, or give set ${task.id} --doc the document that has it`,
    }[command];
    return `no section "${prefix}..." in docs/${task.doc}: ${fix}`;
  }
  if (headings.length > 1) {
    return `${headings.length} sections "${prefix}..." in docs/${task.doc}: keep one of them`;
  }
  // Markdown drops the blanks after the text of a heading; a line end is
  // already gone with the split.
  const text = heading.slice(4).replace(/[ \t]+$/, "");
  const markup = markupIn(text);
  if (markup !== undefined) {
    return `the section "### ${text}" of docs/${task.doc} has ${markup}, and the anchor of the link of docs/00_STATUS.md is not worked out for markup: write the heading as plain text, then give the tracker its title`;
  }
  if (anchorOf(text) !== slug(task.id, task.title)) {
    const title = text.slice(prefix.length - 4);
    const fix = {
      add: `give add the title of the section, "${title}", or retitle the section`,
      set: `give set ${task.id} --title "${title}", or retitle the section`,
      check: `give set ${task.id} --title "${title}", or retitle the section`,
    }[command];
    return `title "${task.title}" does not match the section "${prefix}${title}" of docs/${task.doc}: the link of docs/00_STATUS.md misses it; ${fix}`;
  }
  // GitHub gives a heading whose anchor an earlier one has the anchor with
  // -1 after it: the link lands on whichever of them comes first.
  const anchor = anchorOf(text);
  const same = lines.filter((line) => {
    const other = HEADING.exec(line)?.[1];
    return other !== undefined && anchorOf(other) === anchor;
  }).length;
  if (same > 1) {
    return `the anchor "#${anchor}" of the section "### ${text}" is that of ${same} headings of docs/${task.doc}: the link of docs/00_STATUS.md lands on the first of them; give each of them a text of its own`;
  }
  return undefined;
}

/**
 * The tasks whose section is not where docs/00_STATUS.md links, one line each
 * (`E1-12: title ...`), with the fix `render --check` can name. A document is
 * read and split once. Every `doc` of `tasks` is a file: `render --check`
 * asks this only of a tracker `badDocs` has nothing against.
 *
 * @param {ReadonlyArray<{ id: string, title: string, doc: string }>} tasks
 * @param {string} docsDir the absolute path of `docs/`
 * @returns {string[]}
 */
export function badSections(tasks, docsDir) {
  /** @type {Map<string, string[]>} */
  const lines = new Map();
  /** @type {(path: string) => string[]} */
  const linesOf = (path) => {
    const known = lines.get(path);
    if (known !== undefined) return known;
    const prose = proseLines(readFileSync(path, "utf8"));
    lines.set(path, prose);
    return prose;
  };
  /** @type {string[]} */
  const bad = [];
  for (const task of tasks) {
    const problem = sectionProblem(task, docsDir, "check", linesOf);
    if (problem !== undefined) bad.push(`${task.id}: ${problem}`);
  }
  return bad;
}
