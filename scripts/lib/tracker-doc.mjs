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
 * of code or an HTML block is not a heading (`markdown.mjs`). A heading with
 * markup that moves its anchor, or that GitHub numbers because an earlier
 * heading of the document has its anchor, is refused: the link could miss it.
 * `sectionProblem` and `badSections` hold the tracker to that.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gemoji } from "gemoji";
import GithubSlugger from "github-slugger";
import { codeOf } from "./files.mjs";
import { headingsOf } from "./markdown.mjs";
import { TASK_ID_SOURCE } from "./tracker-task.mjs";

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
  const form = docFormProblem(doc);
  if (form !== undefined || typeof doc !== "string") return form;
  let path = docsDir;
  for (const segment of doc.split("/")) {
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
 * Why `doc` is not written as the `doc` of a task, the disk not looked at:
 * a path from `docs/` without `docs/` before it, `/`-separated, no `.` or
 * `..` segment and not absolute - so it cannot leave `docs/`. `docProblem`
 * holds a value to this first; the fixture of the tracker
 * (`tracker-fixture.mjs`), which writes the documents, to this alone.
 *
 * @param {unknown} doc
 * @returns {string | undefined}
 */
export function docFormProblem(doc) {
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
  if (doc.split("/").some((segment) => segment === "." || segment === "..")) {
    return `doc "${doc}" has a . or .. segment: give a path from docs/ that stays in it`;
  }
  return undefined;
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
 * The anchors GitHub gives the headings of one document, in their order:
 * github-slugger 2.0.0, the library GitHub and VS Code make anchors with -
 * the text lowercased, everything but letters, marks, digits, letter
 * numbers, connector punctuation, `-` and the blank cut out, every blank made
 * a `-`, one by one (so a ` - ` between words is `---` and a cut `—` between
 * two blanks leaves `--`); a heading whose anchor an earlier one has gets it
 * with `-1`, `-2` after it. A rule of our own would hold the tracker to
 * itself and let a link miss its section. The one place the library is
 * called: `anchorOf` is the first anchor of a document of its own.
 *
 * @returns {(headingText: string) => string} the anchor of the next heading,
 *   by its text as rendered (`Heading.plain`)
 */
function anchorsInOrder() {
  const slugger = new GithubSlugger();
  return (headingText) => slugger.slug(headingText);
}

/**
 * The anchor of a heading by its text alone, before any numbering.
 *
 * @param {string} headingText the text of the heading as rendered (`Heading.plain`)
 * @returns {string}
 */
function anchorOf(headingText) {
  return anchorsInOrder()(headingText);
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
 * The names of the emoji GitHub renders for `:name:` that are no Unicode
 * emoji, and so not in gemoji: a frozen snapshot of `GET /emojis` of the
 * GitHub REST API without its Unicode entries, as of 03.11.2026. GitHub may
 * add one later; the snapshot is dated, not watched (docs/TECH_DEBT.md
 * § E0-12AM).
 */
export const GITHUB_CUSTOM_EMOJI = [
  "accessibility",
  "atom",
  "basecamp",
  "basecampy",
  "bowtie",
  "dependabot",
  "electron",
  "feelsgood",
  "finnadie",
  "fishsticks",
  "goberserk",
  "godmode",
  "hurtrealbad",
  "neckbeard",
  "octocat",
  "rage1",
  "rage2",
  "rage3",
  "rage4",
  "shipit",
  "suspect",
  "trollface",
];

/** The names of the gemoji package, the Unicode emoji GitHub renders for `:name:`. */
export const GEMOJI_NAMES = new Set(gemoji.flatMap((entry) => entry.names));

/** The names of the emoji GitHub renders for `:name:`: gemoji and its own. */
const EMOJI = new Set([...GEMOJI_NAMES, ...GITHUB_CUSTOM_EMOJI]);

/**
 * What a token of a heading is called in the reason of a refusal; the markup
 * is the character the token was written with.
 *
 * @param {{ type: string, markup: string }} token
 * @returns {string}
 */
function nameOfMarkup({ type, markup }) {
  switch (type) {
    case "em_open":
    case "strong_open":
      return `emphasis (${markup[0] ?? "*"})`;
    case "link_open":
      return "a link ([)";
    case "image":
      return "an image (![)";
    case "html_inline":
      return "inline HTML (<)";
    case "s_open":
      return "strikethrough (~)";
    default:
      return `markup (${type})`;
  }
}

/**
 * The markup in a heading that changes its anchor in a way `anchorOf` does
 * not work out. The anchor is made of the text as GitHub renders it, and the
 * parser (`markdown.mjs`) renders as GitHub does: whatever is not plain text
 * or a code span - emphasis, a link, an image, inline HTML, strikethrough -
 * is markup, and an emoji `:name:` of gemoji or of GitHub itself (`EMOJI`) too (`test:int:` is not one). A
 * section is an ATX heading, one line, so a line break is never in it.
 * Escapes and entities are decoded before the anchor is made. Such a heading
 * is refused rather than rendered here, so a link that may miss its section
 * is never green.
 *
 * @param {import("./markdown.mjs").Heading} heading
 * @returns {string | undefined} the markup found, undefined for none
 */
function markupIn(heading) {
  const [token] = heading.markup;
  if (token !== undefined) return nameOfMarkup(token);
  return emojiIn(heading);
}

/**
 * The first emoji `:name:` of `EMOJI` in the text of a heading, as a reason
 * names it (`an emoji (:tada:)`); undefined for none. A code span holds none.
 *
 * @param {import("./markdown.mjs").Heading} heading
 * @returns {string | undefined}
 */
function emojiIn(heading) {
  for (const text of heading.texts) {
    for (const match of text.matchAll(/(?=:([^:\s]+):)/g)) {
      const name = match[1];
      if (name !== undefined && EMOJI.has(name)) return `an emoji (:${name}:)`;
    }
  }
  return undefined;
}

/**
 * A section heading starts with the id, a dot that ends the id and one blank
 * before the title, the form `sectionHeading` writes. After a tab or a no-break
 * space the anchor has the title glued to the id, which no title given to
 * `set` makes; after a second blank the title to give would start with one.
 * Such a heading is no section, and the fix named is to write one.
 */
const SECTION_ID = new RegExp(`^(${TASK_ID_SOURCE})\\. (?=\\S)`);

/**
 * A section `### <id>. <title>` of a document: its heading; the title, the
 * text after `<id>. ` in the text the id was found in - as rendered, so the
 * title it gives makes the anchor of the heading; the anchor by that text;
 * the anchor GitHub gives the heading in the document (`given`: a heading
 * whose anchor an earlier one has, by its text or by the `-1` GitHub gave
 * that one, gets one with `-1`, `-2` after it); and the number of headings
 * with an emoji up to it (`emojiBefore`) - only those can change `given`, a
 * heading further on numbers no anchor before it.
 *
 * @typedef {{
 *   heading: import("./markdown.mjs").Heading,
 *   title: string,
 *   anchor: string,
 *   given: string,
 *   emojiBefore: number,
 * }} Section
 */

/**
 * The headings of a document as the section of a task and its link need
 * them, worked out once: the sections by id, and the headings with an emoji,
 * whose anchor is not worked out (`emojiIn`), in their order.
 *
 * @typedef {{
 *   sections: Map<string, Section[]>,
 *   emoji: { heading: import("./markdown.mjs").Heading, emoji: string }[],
 * }} SectionIndex
 */

/**
 * The index of a document. The section of a task is an ATX heading of the
 * third level (`### E0-05. title`) in a list or a quote too; the id ends at
 * the dot, so `### E0-12A.` is not the section of `E0-12AA`. A line of a
 * fenced block of code or of an HTML block is not a heading (`markdown.mjs`).
 * Every heading counts for the anchors GitHub numbers, a setext one and one
 * of another level too.
 *
 * @param {string} text
 * @returns {SectionIndex}
 */
export function sectionIndex(text) {
  /** @type {SectionIndex} */
  const index = { sections: new Map(), emoji: [] };
  const givenAnchor = anchorsInOrder();
  for (const heading of headingsOf(text)) {
    const anchor = anchorOf(heading.plain);
    const given = givenAnchor(heading.plain);
    const emoji = emojiIn(heading);
    if (emoji !== undefined) index.emoji.push({ heading, emoji });
    if (heading.level !== 3) continue;
    const found = SECTION_ID.exec(heading.plain);
    const id = found?.[1];
    if (found === null || id === undefined) continue;
    const title = heading.plain.slice(found[0].length);
    const entry = {
      heading,
      title,
      anchor,
      given,
      emojiBefore: index.emoji.length,
    };
    index.sections.set(id, [...(index.sections.get(id) ?? []), entry]);
  }
  return index;
}

/**
 * How to set a section problem right, by the command that met it: `add`
 * before the task is in the tracker; `set` on a task that is, given no
 * `--title` - the fix is the same command again with the title, whatever
 * else it gives (`--doc`, `--deps`, `--est`); `set-title`, the same given a
 * `--title` - the fix is that command with the title of the section in place
 * of the one given, not a second `--title`, which `set` refuses; and
 * `check` for `render --check`, which names a task already written.
 *
 * @typedef {"add" | "set" | "set-title" | "check"} Command
 */

/**
 * The label of the line under a refusal that holds the title of the section
 * to give, as data: no fix is a command to paste into a shell, which would
 * run whatever the heading holds (`$(…)`, `'; …; '`), POSIX shell or
 * PowerShell alike. What follows the label to the end of the line is the
 * title, nothing quoted or escaped.
 */
const TITLE_LABEL = "  the title of the section: ";

/**
 * The index of the document at `path`, read from the disk.
 *
 * @param {string} path
 * @returns {SectionIndex}
 */
const readIndex = (path) => sectionIndex(readFileSync(path, "utf8"));

/**
 * Why the section `### <id>. <title>`, written with the title as it is, is
 * not the section of a task of that title, as the reason goes on after the
 * title (`has emphasis (*)`, `reads as "a & b" in a heading`); undefined if
 * it is. Its own index, by the rules `sectionProblem` holds a section to.
 *
 * @param {string} id
 * @param {string} title
 * @returns {string | undefined}
 */
function unwritableTitle(id, title) {
  const [written] =
    sectionIndex(`${sectionHeading(id, title)}\n`).sections.get(id) ?? [];
  if (written === undefined) return "is no section heading as written";
  const markup = markupIn(written.heading);
  if (markup !== undefined) return `has ${markup}`;
  if (written.anchor !== slug(id, title)) {
    return `reads as "${written.title}" in a heading`;
  }
  return undefined;
}

/**
 * Why the document of `task` does not hold its section, undefined if it does
 * (and for a task of `DEFAULT_DOC`, which needs none); the reason ends with
 * what to do about it, as `command` can do it.
 *
 * @param {{ id: string, title: string, doc: string }} task
 * @param {string} docsDir the absolute path of `docs/`
 * @param {Command} command
 * @param {(path: string) => SectionIndex} [indexOfPath] the index of a file; the disk by default
 * @returns {string | undefined}
 */
export function sectionProblem(
  task,
  docsDir,
  command,
  indexOfPath = readIndex,
) {
  if (task.doc === DEFAULT_DOC) return undefined;
  const prefix = sectionHeading(task.id, "");
  const wanted = `"${sectionHeading(task.id, task.title)}"`;
  const { sections, emoji } = indexOfPath(join(docsDir, task.doc));
  const found = sections.get(task.id) ?? [];
  const [first] = found;
  if (first === undefined) {
    // The section to write is the heading of the title as it is: one that
    // heading would not make - markup in it, or a text that renders as
    // another - is no fix, the same refusal would follow it.
    const unwritable = unwritableTitle(task.id, task.title);
    if (unwritable !== undefined) {
      const doc = `docs/${task.doc}`;
      const fix = {
        add: `give add a title of plain text, then write its section in ${doc}`,
        set: `give the same set --title a title of plain text and write its section in ${doc}`,
        "set-title": `give the same set a title of plain text with --title in place of the one given, and write its section in ${doc}`,
        check: `give set ${task.id} --title a title of plain text and write its section in ${doc}`,
      }[command];
      return `no section "${prefix}..." in ${doc}, and the title "${task.title}" ${unwritable}, so a section written with it is refused too: ${fix}`;
    }
    const fix = {
      add: `write the section ${wanted} in docs/${task.doc} first, then add the task`,
      set: `write the section ${wanted} in docs/${task.doc} first, or give --doc the document that has it`,
      "set-title": `write the section ${wanted} in docs/${task.doc} first, or give --doc the document that has it`,
      check: `write the section ${wanted} in docs/${task.doc}, or give set ${task.id} --doc the document that has it`,
    }[command];
    return `no section "${prefix}..." in docs/${task.doc}: ${fix}`;
  }
  if (found.length > 1) {
    return `${found.length} sections "${prefix}..." in docs/${task.doc}: keep one of them`;
  }
  const { heading, title, anchor, given, emojiBefore } = first;
  const markup = markupIn(heading);
  if (markup !== undefined) {
    return `the section "### ${heading.source}" of docs/${task.doc} has ${markup}, and the anchor of the link of docs/00_STATUS.md is not worked out for markup: write the heading as plain text, then give the tracker its title`;
  }
  // `&#10;` and `&#13;` are a line break as rendered: no title of one line,
  // and so none given to the tracker, makes that anchor.
  if (/[\r\n]/.test(title)) {
    return `the section "### ${heading.source}" of docs/${task.doc} has a line break entity, write the heading as plain text`;
  }
  if (anchor !== slug(task.id, task.title)) {
    // A blank at the end of the title as rendered (`&#32;`, `&#9;`) is one
    // no title given to the tracker has (`checkTitle` of scripts/tasks.mjs):
    // naming that title would only meet the next refusal. The blank at the
    // start leaves the heading no section (`SECTION_ID`).
    if (title.trim() !== title) {
      return `the section "### ${heading.source}" of docs/${task.doc} has a blank entity at the end of its title, which no title given to the tracker has: write the heading as plain text`;
    }
    // The title to give is the text the id was found in, after the id: the
    // text as rendered, escapes and entities decoded, so the anchor it makes
    // is that of the heading. No command to paste is made of it: a shell
    // would run what the heading holds. The fix names the flag, the title
    // is data on a line of its own, after a fixed label.
    const fix = {
      add: "give add the title of the section, or retitle the section",
      set: "give the same set --title with the title of the section too, or retitle the section",
      "set-title":
        "give the same set the title of the section with --title in place of the one given, or retitle the section",
      check: `give set ${task.id} --title the title of the section, or retitle the section`,
    }[command];
    return `title "${task.title}" does not match the section "${prefix}${title}" of docs/${task.doc}: the link of docs/00_STATUS.md misses it; ${fix}\n${TITLE_LABEL}${title}`;
  }
  // GitHub renders `:name:` of `EMOJI` as a picture, and the anchor of a
  // heading with one is not worked out here: the anchors of the headings
  // before the section, the numbers GitHub gives them and so the link may be
  // other than they look. A heading after the section numbers none of them.
  const [withEmoji] = emoji;
  if (emojiBefore > 0 && withEmoji !== undefined) {
    return `the heading "${withEmoji.heading.plain}" of docs/${task.doc} has ${withEmoji.emoji}, whose anchor is not worked out: the anchor GitHub gives the section "### ${heading.source}" may be another; write that heading as plain text`;
  }
  // GitHub gives a heading whose anchor an earlier one has - by its text or
  // by the -1 GitHub gave it - the anchor with -1 after it: the link lands on
  // the earlier one. A later heading with the anchor takes the -1 itself.
  if (given !== anchor) {
    return `GitHub gives the section "### ${heading.source}" of docs/${task.doc} the anchor "#${given}", an earlier heading having "#${anchor}": the link of docs/00_STATUS.md lands on that one; give each of them a text of its own`;
  }
  return undefined;
}

/**
 * The tasks whose section is not where docs/00_STATUS.md links, one line each
 * (`E1-12: title ...`), with the fix `render --check` can name. A document is
 * read and indexed once, whatever the number of its tasks. Every `doc` of
 * `tasks` is a file: `render --check` asks this only of a tracker `badDocs`
 * has nothing against.
 *
 * @param {ReadonlyArray<{ id: string, title: string, doc: string }>} tasks
 * @param {string} docsDir the absolute path of `docs/`
 * @param {(path: string) => SectionIndex} [read] the index of a file; the disk by default
 * @returns {string[]}
 */
export function badSections(tasks, docsDir, read = readIndex) {
  /** @type {Map<string, SectionIndex>} */
  const indexes = new Map();
  /** @type {(path: string) => SectionIndex} */
  const indexOfPath = (path) => {
    const known = indexes.get(path);
    if (known !== undefined) return known;
    const index = read(path);
    indexes.set(path, index);
    return index;
  };
  /** @type {string[]} */
  const bad = [];
  for (const task of tasks) {
    const problem = sectionProblem(task, docsDir, "check", indexOfPath);
    if (problem !== undefined) bad.push(`${task.id}: ${problem}`);
  }
  return bad;
}
