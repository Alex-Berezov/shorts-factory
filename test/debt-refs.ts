import { proseLines } from "../scripts/lib/markdown.mjs";
import { TASK_ID_SOURCE } from "../scripts/lib/tracker-task.mjs";

/**
 * The one form of a reference to the debt table in code: `docs/TECH_DEBT.md
 * § <id>`, the id of the task the row went to (a refinement may follow after
 * a comma: `§ E0-12H, п.5`). A line number of the table goes stale at the
 * next row added, a date or a column name is not an address the tracker
 * knows, and any other spelling reads as a second way to write the same
 * thing - so every mention of the table that is not this form is refused,
 * save the bare name of the file in the few places that name the file and
 * not a row (`BARE_MENTIONS` of the test).
 *
 * What is checked of an address is that its id is a task of the tracker and
 * one of the ids the table names as the task of some row (`debtAddresses`):
 * the id right after the outcome of a row in the column «Исход», the first
 * id of the column «Откуда» of a row still «открыто» with no task named, or
 * a section `### <id>.` of the document. Which row the comment is about is
 * not known here - the rows have no id of their own - so a reference to the
 * task of another row passes (docs/TECH_DEBT.md § E0-12X).
 *
 * The text is read with the breaks of a comment folded away, so a reference
 * wrapped over two lines of a comment is one reference.
 */

const MENTION = /TECH_DEBT/g;
const ADDRESS = new RegExp(
  `docs/TECH_DEBT\\.md § (${TASK_ID_SOURCE})(?![\\w-])`,
  "y",
);
/**
 * The file named and nothing after it that would make it an address (a line
 * number, a comma, the section sign); the dot may be escaped, as in a
 * regular expression of a test.
 */
const BARE =
  /(?<!:\d+ of (?:docs\/)?)(?:docs\/)?TECH_DEBT\\?\.md(?!:\d|,|\s*§)/y;
const SECTION = new RegExp(`^### (${TASK_ID_SOURCE})\\. `);
const ID_TOKEN = new RegExp(`(?<![\\w-])${TASK_ID_SOURCE}(?![\\w-])`);
/**
 * The task of a row in its outcome: the id right after the word of the
 * outcome, as the column writes it - `закрыто: <id>`, `закрыто <id>`,
 * `закрыто частично: <id>`, `частично закрыто <id>`, `закрыто наполовину:
 * <id>`, `закрыт <id>` or `закрыта <id>` (after `сужено:`), `открыто: <id>`, `открыто ->
 * <id>` (or `→`), `переадресовано <id>`, `переадресовано: <id>`, `принято:
 * <id>`, `принято с условием: <id>`. An id further on (`до E0-12E`, `см.
 * E0-05`) is not the task of the row.
 */
const OUTCOME_TASK = new RegExp(
  `(?<!\\p{L})(?:закрыт[оа]?|открыто|переадресовано|принято(?: с условием)?|сужено)(?: (?:частично|наполовину))?:?(?: (?:->|→))? +(${TASK_ID_SOURCE})(?![\\w-])`,
  "giu",
);
/** What a row was before its outcome changed: not its task now. */
const FORMER = /было:/i;

/** `text` on one line: a line break with the comment marker after it is one blank. */
function folded(text: string): string {
  return text.replace(/\s*\r?\n\s*(?:\*|\/\/|#)?\s*/g, " ");
}

/** The cells of a row of a markdown table, split at the pipes that are not escaped. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * The ids the debt table names as the task of a row (see the docblock), read
 * from the text of docs/TECH_DEBT.md: the tables by their header row, the
 * columns by name, a line in a fenced block of code not at all.
 */
export function debtAddresses(text: string): Set<string> {
  const ids = new Set<string>();
  const lines = proseLines(text);
  let outcome = -1;
  let source = -1;
  let inTable = false;
  for (const [index, line] of lines.entries()) {
    const heading = SECTION.exec(line);
    if (heading?.[1] !== undefined) ids.add(heading[1]);
    if (!line.trimStart().startsWith("|")) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      // A table starts at a row with the separator row under it.
      if (!SEPARATOR.test(lines[index + 1] ?? "")) continue;
      const header = cells(line);
      outcome = header.indexOf("Исход");
      source = header.indexOf("Откуда");
      inTable = true;
      continue;
    }
    if (SEPARATOR.test(line) || outcome === -1) continue;
    const row = cells(line);
    const [result = ""] = (row[outcome] ?? "").split(FORMER);
    const tasks = [...result.matchAll(OUTCOME_TASK)].map((match) => match[1]);
    for (const id of tasks) if (id !== undefined) ids.add(id);
    if (source !== -1 && tasks.length === 0 && /^открыто/i.test(result)) {
      const found = ID_TOKEN.exec(row[source] ?? "")?.[0];
      if (found !== undefined) ids.add(found);
    }
  }
  return ids;
}

/** Where the references in `text` may point, and whether it may name the file bare. */
export interface DebtRefContext {
  /** The ids of the tracker. */
  readonly taskIds: ReadonlySet<string>;
  /** The ids the table names as the task of a row (`debtAddresses`). */
  readonly addresses: ReadonlySet<string>;
  /** The file is one that names the table, not a row of it. */
  readonly bareAllowed: boolean;
}

/** What is wrong with the references to the debt table in `text`. */
export function debtRefProblems(
  text: string,
  { taskIds, addresses, bareAllowed }: DebtRefContext,
): string[] {
  const flat = folded(text);
  const problems: string[] = [];
  for (const mention of flat.matchAll(MENTION)) {
    const at = mention.index;
    ADDRESS.lastIndex = at - "docs/".length;
    const id = at >= "docs/".length ? ADDRESS.exec(flat)?.[1] : undefined;
    if (id !== undefined) {
      if (!taskIds.has(id)) {
        problems.push(`addresses ${id}, which is not a task of the tracker`);
      } else if (!addresses.has(id)) {
        problems.push(
          `addresses ${id}, which docs/TECH_DEBT.md does not name as the task of a row or a section`,
        );
      }
      continue;
    }
    if (bareAllowed) {
      const start = flat.startsWith("docs/", at - "docs/".length)
        ? at - "docs/".length
        : at;
      BARE.lastIndex = start;
      if (BARE.test(flat)) continue;
    }
    const near = flat.slice(Math.max(0, at - 12), at + 24);
    problems.push(`names the debt table not in the one form: "${near}"`);
  }
  return problems;
}

/**
 * The text of a file of the scope of the lock, undefined for a binary one (a
 * NUL byte in it, as in an image or an archive). Every other file is read,
 * whatever its name: a migration, a shell script or a Dockerfile can hold a
 * reference as well as a module.
 */
export function textOf(bytes: Uint8Array): string | undefined {
  return bytes.includes(0) ? undefined : new TextDecoder().decode(bytes);
}
