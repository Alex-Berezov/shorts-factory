/**
 * A tree of the tracker for a test of `scripts/tasks.mjs --root=<dir>`: the
 * one writer of it for the tests of the CLI (`test/tasks-cli.test.ts`) and the
 * probe of the gate `tracker` (`.claude/hooks/selftest-gates.js`), so that
 * neither keeps a copy of how a document of tasks looks. Synchronous, no
 * top-level await: the CommonJS of the probe loads it with `require`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DOC, docFormProblem, sectionHeading } from "./tracker-doc.mjs";

/**
 * The journal the tree starts with: its title only, not the head
 * `scripts/tasks.mjs` writes to a journal that is not there - a case reads
 * the lines the CLI appends, not the head.
 */
const JOURNAL_START = "# Журнал работ\n\n";

/**
 * Writes the tree under `root`: `docs/tasks/tasks.json` with `tasks`,
 * `docs/90_WORKLOG.md`, and documents with the section `### <id>. <title>` of
 * each task that names them - those of `docs` when it is given (a task whose
 * doc is not among them has none written, as a case of a missing document
 * wants), else the doc of every task but those of the default, `00_STATUS.md`,
 * which is the status and is left to `render`. A doc of a task or a name of
 * `docs` that the tracker would not take - one that leaves `docs/` among them
 * - is refused before anything is written.
 *
 * @param {string} root an existing directory
 * @param {ReadonlyArray<{ id: string, title: string, doc?: unknown }>} tasks
 * @param {{ docs?: string[], json?: string }} [options] `docs` - the documents to
 *   write; `json` - the text of tasks.json, `tasks` serialized by default
 * @returns {void}
 */
export function writeTrackerTree(root, tasks, options = {}) {
  const docsDir = join(root, "docs");
  // The rule of the form of a doc the tracker holds (`docFormProblem`): a doc
  // it takes cannot leave docs/, and one it does not take is no tree to test.
  // Even with `json` given: a tree for a case of `badDocs` is not built here
  // (docs/TECH_DEBT.md § E0-12AM, З3-2).
  for (const task of tasks) {
    const problem = docFormProblem(task.doc);
    if (problem !== undefined) throw new Error(`${task.id}: ${problem}`);
  }
  for (const name of options.docs ?? []) {
    const problem = docFormProblem(name);
    if (problem !== undefined) throw new Error(`document to write: ${problem}`);
  }
  /** @type {Set<string>} */
  const names = new Set(
    options.docs ??
      tasks.flatMap((task) =>
        typeof task.doc === "string" && task.doc !== DEFAULT_DOC
          ? [task.doc]
          : [],
      ),
  );
  mkdirSync(join(docsDir, "tasks"), { recursive: true });
  writeFileSync(
    join(docsDir, "tasks", "tasks.json"),
    options.json ?? `${JSON.stringify(tasks, null, 2)}\n`,
  );
  writeFileSync(join(docsDir, "90_WORKLOG.md"), JOURNAL_START);
  for (const name of names) {
    const sections = tasks
      .filter((task) => task.doc === name)
      .map((task) => `${sectionHeading(task.id, task.title)}\n`);
    const path = join(docsDir, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# doc\n\n${sections.join("\n")}`);
  }
}
