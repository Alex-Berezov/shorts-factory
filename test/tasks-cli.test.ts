import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  DEFAULT_DOC,
  badDocs,
  badSections,
  docProblem,
  sectionHeading,
  sectionProblem,
  slug,
} from "../scripts/lib/tracker-doc.mjs";
import { readRepoFile } from "./repo-files.js";
import { type Task, TrackerSchema, readTracker, taskEntry } from "./tracker.js";

/**
 * The tracker CLI (`scripts/tasks.mjs`) names its commands when it is given
 * one it does not know. The list it prints is held to the `case` labels of
 * its own `switch`, read from the source, so a command added to one and not
 * the other is red here.
 */
const SCRIPT = join(repoRoot, "scripts", "tasks.mjs");

/** How long the CLI may take before the run is killed and the case is red. */
const RUN_TIMEOUT_MS = 20_000;

/** The `case "..."` labels of the script's command switch. */
function caseLabels(): string[] {
  const source = readRepoFile("scripts/tasks.mjs");
  return [...source.matchAll(/^\s*case "([a-z-]+)":/gm)]
    .map((match) => match[1])
    .filter((label): label is string => label !== undefined);
}

describe("tasks.mjs, an unknown command", () => {
  let result: SpawnSyncReturns<string>;
  beforeAll(() => {
    result = spawnSync(process.execPath, [SCRIPT, "no-such-command"], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
  }, RUN_TIMEOUT_MS + 5_000);

  it("fails", () => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command no-such-command");
  });

  it("names every command the script has", () => {
    const labels = caseLabels();
    const valid = /Valid: ([^;]*);/.exec(result.stderr)?.[1]?.split(", ");

    expect(labels.length).toBeGreaterThanOrEqual(10);
    expect(labels).toContain("add");
    expect([...(valid ?? [])].sort()).toEqual([...labels].sort());
  });
});

/**
 * `--root=<dir>` counts only as the first argument; anywhere else the command
 * would run on the tracker of the repository, so it is refused. The cases run
 * `next`, which reads and does not write: a regression that lets one through
 * prints the next task of the repository and exits 0, and writes nothing.
 */
describe("tasks.mjs, --root= not given as the first argument", () => {
  // Made when the cases run, not when they are collected: a run filtered
  // with -t leaves no directory behind.
  let elsewhere: string;
  beforeAll(() => {
    elsewhere = mkdtempSync(join(tmpdir(), "sf-tracker-root-"));
  });
  afterAll(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it.each([
    ["after the command", (dir: string) => ["next", `--root=${dir}`]],
    [
      "a second time",
      (dir: string) => [`--root=${dir}`, "next", `--root=${dir}`],
    ],
    ["with a space", (dir: string) => ["next", "--root", dir]],
    ["first, with a space", (dir: string) => ["--root", dir, "next"]],
    ["first, with no directory", () => ["--root=", "next"]],
  ])("is refused %s, before anything is read", (_, argsFor) => {
    const repoTracker = readRepoFile(TRACKER);
    const args = argsFor(elsewhere);
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("give the tree as --root=<dir>");
    expect(result.stdout).toBe("");
    expect(readRepoFile(TRACKER)).toBe(repoTracker);
  });
});

/** A task of a made-up tracker, titled `Task <id>` (`taskEntry`). */
const task = (id: string, doc: string): Task => taskEntry({ id, doc });

const TRACKER = "docs/tasks/tasks.json";
const STATUS = "docs/00_STATUS.md";
const WORKLOG = "docs/90_WORKLOG.md";

/**
 * A tree of its own for the CLI (`--root=<dir>`): docs/tasks/tasks.json with
 * `tasks`, the documents `docs` names, a journal and docs/00_STATUS.md
 * rendered by the CLI itself. Each document holds the section
 * `### <id>. <title>` of every task that names it. Every case that writes, and every case that
 * must not, runs here: a regression that writes where it should refuse
 * changes this copy, never the tracker of the repository.
 */
function scratchTracker(tasks: Task[], docs: string[]) {
  const root = mkdtempSync(join(tmpdir(), "sf-tracker-"));
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(join(root, TRACKER), `${JSON.stringify(tasks, null, 2)}\n`);
  writeFileSync(join(root, WORKLOG), "# Журнал работ\n\n");
  const write = (doc: string, text: string): void =>
    writeFileSync(join(root, "docs", doc), text);
  for (const doc of docs) {
    const sections = tasks
      .filter((entry) => entry.doc === doc)
      .map((entry) => `${sectionHeading(entry.id, entry.title)}\n`);
    write(doc, `# doc\n\n${sections.join("\n")}`);
  }
  const run = (args: string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const rendered = run(["render"]);
  if (rendered.status !== 0) {
    throw new Error(`render of the copy failed: ${rendered.stderr}`);
  }
  return {
    root,
    run,
    read,
    write,
    /** The tracker of the copy, held to the schema. */
    tasks: (): Task[] => TrackerSchema.parse(JSON.parse(read(TRACKER))),
    /** Runs `args` and holds the tracker, the status and the journal to what they were. */
    refused(args: string[]): SpawnSyncReturns<string> {
      const before = [TRACKER, STATUS, WORKLOG].map(read);
      const result = run(args);
      expect([TRACKER, STATUS, WORKLOG].map(read)).toEqual(before);
      return result;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type Scratch = ReturnType<typeof scratchTracker>;

describe("the doc of a task", () => {
  // Made when the cases run, not when they are collected: a run filtered
  // with -t leaves no directory behind.
  let docs: string;
  beforeAll(() => {
    docs = mkdtempSync(join(tmpdir(), "sf-tracker-doc-"));
    writeFileSync(join(docs, "TECH_DEBT.md"), "# debt\n");
    mkdirSync(join(docs, "adr"));
    writeFileSync(join(docs, "adr", "README.md"), "# adr\n");
  });
  afterAll(() => {
    rmSync(docs, { recursive: true, force: true });
  });

  it.each(["TECH_DEBT.md", "adr/README.md"])(
    "takes %s, a file of docs/",
    (doc) => {
      expect(docProblem(doc, docs)).toBeUndefined();
    },
  );

  it.each([
    ["docs/TECH_DEBT.md", "starts with docs/"],
    ["./docs/TECH_DEBT.md", "starts with docs/"],
    ["docs\\TECH_DEBT.md", "starts with docs/"],
    ["NOPE.md", "names no file"],
    ["adr", "names no file"],
    ["", "doc is empty"],
    ["../sf-tracker-doc-outside.md", "has a . or .. segment"],
    ["adr/../TECH_DEBT.md", "has a . or .. segment"],
    ["./TECH_DEBT.md", "has a . or .. segment"],
    ["/TECH_DEBT.md", "is an absolute path"],
    ["C:/TECH_DEBT.md", "is an absolute path"],
    ["adr\\README.md", "has a backslash"],
    ["tech_debt.md", '"tech_debt.md" is "TECH_DEBT.md" on disk'],
    ["ADR/README.md", '"ADR" is "adr" on disk'],
    ["adr/readme.md", '"readme.md" is "README.md" on disk'],
  ])("refuses %j", (doc, why) => {
    expect(docProblem(doc, docs)).toContain(why);
  });

  it("refuses the absolute path of a file of docs/", () => {
    expect(docProblem(join(docs, "TECH_DEBT.md"), docs)).toContain(
      "is an absolute path",
    );
  });

  it("names every task whose doc is not a file of docs/, a task without one too", () => {
    expect(
      badDocs(
        [
          { id: "A-1", doc: "TECH_DEBT.md" },
          { id: "A-2", doc: "docs/TECH_DEBT.md" },
          { id: "A-3", doc: "GONE.md" },
          { id: "A-4" },
          { id: "A-5", doc: 7 },
        ],
        docs,
      ),
    ).toEqual([
      expect.stringMatching(/^A-2: /),
      expect.stringMatching(/^A-3: /),
      "A-4: doc is missing",
      "A-5: doc is missing",
    ]);
  });

  it("is a file of docs/ for every task of the tracker", () => {
    const tasks = readTracker();
    // Nothing parsed would pass on nothing.
    expect(tasks).not.toHaveLength(0);
    expect(badDocs(tasks, join(repoRoot, "docs"))).toEqual([]);
  });

  it("holds the section of every task of the tracker where docs/00_STATUS.md links", () => {
    const tasks = readTracker();
    expect(tasks).not.toHaveLength(0);
    expect(badSections(tasks, join(repoRoot, "docs"))).toEqual([]);
  });
});

describe("the section of a task", () => {
  let docs: string;
  beforeAll(() => {
    docs = mkdtempSync(join(tmpdir(), "sf-tracker-section-"));
    writeFileSync(
      join(docs, "A.md"),
      "# a\n\n### E0-02. Second task\n\n### E0-0222. Other\n\n### E0-03. Third task\n\n### E0-03. Third task\n",
    );
    writeFileSync(
      join(docs, "CRLF.md"),
      "# a\r\n\r\n### E0-02. Second task\r\n\r\n### E0-03. Third task\r\n",
    );
    writeFileSync(join(docs, "OTHER.md"), "### E0-0222. Second task\n");
    writeFileSync(
      join(docs, "FENCED.md"),
      [
        "# a",
        "",
        "```md",
        "### E0-02. Second task",
        "```",
        "",
        "### E0-03. Third task",
        "",
        "~~~~",
        "```",
        "### E0-03. Third task",
        "~~~~",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => {
    rmSync(docs, { recursive: true, force: true });
  });

  const second = (doc: string) => ({ id: "E0-02", title: "Second task", doc });
  const third = (doc: string) => ({ id: "E0-03", title: "Third task", doc });

  it("is found by id, title and anchor", () => {
    expect(sectionProblem(second("A.md"), docs, "check")).toBeUndefined();
  });

  it("is found in a CRLF document, and the title it gives ends where the line does", () => {
    expect(sectionProblem(second("CRLF.md"), docs, "check")).toBeUndefined();
    expect(
      sectionProblem({ ...third("CRLF.md"), title: "Other" }, docs, "check"),
    ).toContain('give set E0-03 --title "Third task", or retitle');
  });

  it("is not needed by a task of docs/00_STATUS.md, which is not read", () => {
    expect(
      sectionProblem(second(DEFAULT_DOC), join(docs, "gone"), "check"),
    ).toBeUndefined();
  });

  it("is missing when only a longer id has one", () => {
    expect(sectionProblem(second("OTHER.md"), docs, "check")).toContain(
      'no section "### E0-02. ..." in docs/OTHER.md',
    );
  });

  it("is not a line of a fenced block of code", () => {
    expect(sectionProblem(second("FENCED.md"), docs, "check")).toContain(
      'no section "### E0-02. ..." in docs/FENCED.md',
    );
    // A fence of the other kind, or a shorter one, does not close the block.
    expect(sectionProblem(third("FENCED.md"), docs, "check")).toBeUndefined();
  });

  it.each([
    ["emphasis of *", "Fix *the* gate", "emphasis (*)"],
    ["emphasis of _", "Fix _the_ gate", "emphasis (_ at the edge of a word)"],
    ["inline HTML", "Fix <b>the</b> gate", "inline HTML (<)"],
    ["a link", "Fix [the gate](x.md)", "a link ([)"],
    ["a closing sequence of #", "Fix the gate ###", "a closing sequence of #"],
    ["a named HTML entity", "Fix &amp; gate", "an HTML entity (&...;)"],
    [
      "a numeric HTML entity",
      "Fix &#x27;the&#39; gate",
      "an HTML entity (&...;)",
    ],
  ])("is refused with %s in its heading", (_, title, markup) => {
    writeFileSync(join(docs, "MARKUP.md"), `### E0-05. ${title}\n`);
    expect(
      sectionProblem({ id: "E0-05", title, doc: "MARKUP.md" }, docs, "check"),
    ).toBe(
      `the section "### E0-05. ${title}" of docs/MARKUP.md has ${markup}, and the anchor of the link of docs/00_STATUS.md is not worked out for markup: write the heading as plain text, then give the tracker its title`,
    );
  });

  it.each([
    ["one run of *", "Tests of scripts/** and the rest"],
    ["_ inside a word", "COMPOSE_FILE and profiles"],
    ["a lone & and a colon", "Postgres & Redis: one gate"],
  ])("takes %s in its heading, which is no markup", (_, title) => {
    writeFileSync(join(docs, "PLAIN.md"), `### E0-05. ${title}\n`);
    expect(
      sectionProblem({ id: "E0-05", title, doc: "PLAIN.md" }, docs, "check"),
    ).toBeUndefined();
  });

  it.each([
    ["a heading of another level", "## E0-05. Fifth task"],
    ["a heading that differs only in its signs", "#### E0-05: Fifth task!"],
    ["a heading with a closing sequence", "# E0-05. Fifth task #"],
  ])("is refused when %s has its anchor too", (_, other) => {
    writeFileSync(
      join(docs, "TWICE.md"),
      `### E0-05. Fifth task\n\n${other}\n`,
    );
    expect(
      sectionProblem(
        { id: "E0-05", title: "Fifth task", doc: "TWICE.md" },
        docs,
        "check",
      ),
    ).toBe(
      'the anchor "#e0-05-fifth-task" of the section "### E0-05. Fifth task" is that of 2 headings of docs/TWICE.md: the link of docs/00_STATUS.md lands on the first of them; give each of them a text of its own',
    );
  });

  it("is refused when there are two", () => {
    expect(sectionProblem(third("A.md"), docs, "check")).toBe(
      '2 sections "### E0-03. ..." in docs/A.md: keep one of them',
    );
  });

  it("is refused when the title is not that of the heading, with the title to give", () => {
    const problem = sectionProblem(
      { id: "E0-02", title: "Other title", doc: "A.md" },
      docs,
      "check",
    );
    expect(problem).toContain('title "Other title" does not match the section');
    expect(problem).toContain('give set E0-02 --title "Second task"');
  });

  it.each([
    [
      "add",
      "no section",
      second("OTHER.md"),
      'write the section "### E0-02. Second task" in docs/OTHER.md first, then add the task',
    ],
    [
      "set",
      "no section",
      second("OTHER.md"),
      'write the section "### E0-02. Second task" in docs/OTHER.md first, or give --doc the document that has it',
    ],
    [
      "check",
      "no section",
      second("OTHER.md"),
      'write the section "### E0-02. Second task" in docs/OTHER.md, or give set E0-02 --doc the document that has it',
    ],
    [
      "add",
      "another title",
      { ...second("A.md"), title: "Other" },
      'give add the title of the section, "Second task", or retitle the section',
    ],
    [
      "set",
      "another title",
      { ...second("A.md"), title: "Other" },
      'give set E0-02 --title "Second task", or retitle the section',
    ],
  ] as const)("tells %s what to do about %s", (command, _, task, fix) => {
    const problem = sectionProblem(task, docs, command);
    expect(problem?.endsWith(fix), problem).toBe(true);
    if (command === "add") expect(problem).not.toContain("set E0-02");
  });

  it("names every task whose section is wrong, one line each", () => {
    expect(
      badSections(
        [
          second("A.md"),
          third("A.md"),
          { id: "E0-02", title: "Changed", doc: "A.md" },
        ],
        docs,
      ),
    ).toEqual([
      expect.stringMatching(/^E0-03: 2 sections/),
      expect.stringMatching(/^E0-02: title "Changed" does not match/),
    ]);
  });
});

/**
 * The link of docs/00_STATUS.md lands on the section only with the anchor
 * GitHub gives the heading: every character but letters, digits, `-`, `_`
 * and the blank cut out, each blank a `-` of its own. The titles are those of
 * the headings of the documents, where a rule of our own missed.
 */
describe("the anchor of a section", () => {
  it.each([
    [
      "E0-12H",
      "Postgres: классы SQLSTATE, срок/отмена запроса пробы, closeDb({ timeout })",
      "e0-12h-postgres-классы-sqlstate-срокотмена-запроса-пробы-closedb-timeout-",
    ],
    [
      "E13-02",
      "Очереди, планировщики, DLQ — просмотр и управление",
      "e13-02-очереди-планировщики-dlq--просмотр-и-управление",
    ],
    [
      "E4-05",
      "Job `research.run`: оркестрация plan → verify → brief",
      "e4-05-job-researchrun-оркестрация-plan--verify--brief",
    ],
    [
      "E9-09",
      "Пилот: 2 языка × 2 видео, ADR",
      "e9-09-пилот-2-языка--2-видео-adr",
    ],
    [
      "E0-12K",
      "Гейт compose: один граф у гейта и оператора - запрет override, include/extends под маской when, интерполяция ${}, профили, COMPOSE_FILE, симлинки",
      "e0-12k-гейт-compose-один-граф-у-гейта-и-оператора---запрет-override-includeextends-под-маской-when-интерполяция--профили-compose_file-симлинки",
    ],
    ["E0-12A", "Fix `x`, (y): z [a] ~b^ … ≤", "e0-12a-fix-x-y-z-a-b--"],
  ])("of %s is the one GitHub gives", (id, title, anchor) => {
    expect(slug(id, title)).toBe(anchor);
  });
});

describe("tasks.mjs on a copy of the tracker", () => {
  let scratch: Scratch;
  let repoTracker: string;
  beforeEach(() => {
    repoTracker = readRepoFile(TRACKER);
    scratch = scratchTracker(
      [task("E0-01", "30_E0_TASKS.md"), task("E0-02", "30_E0_TASKS.md")],
      ["30_E0_TASKS.md", "TECH_DEBT.md"],
    );
  });
  afterEach(() => {
    scratch.cleanup();
    // Whatever the case did, it did it to the copy.
    expect(readRepoFile(TRACKER)).toBe(repoTracker);
  });

  it("render --check passes the copy it rendered", () => {
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in sync");
  });

  it("set writes the title and the doc, renders the status and writes the journal", () => {
    scratch.write("TECH_DEBT.md", "### E0-02. Second, renamed\n");
    const result = scratch.run([
      "set",
      "E0-02",
      "--title",
      "Second, renamed",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const tasks = scratch.tasks();
    expect(tasks.find((entry) => entry.id === "E0-02")).toMatchObject({
      title: "Second, renamed",
      doc: "TECH_DEBT.md",
    });
    expect(tasks.find((entry) => entry.id === "E0-01")).toMatchObject({
      title: "Task E0-01",
      doc: "30_E0_TASKS.md",
    });
    expect(scratch.read(STATUS)).toContain("Second, renamed");
    expect(scratch.run(["render", "--check"]).status).toBe(0);
    const journal = scratch.read(WORKLOG).trimEnd().split("\n");
    expect(journal.at(-1)).toMatch(
      /^- \d{4}-\d{2}-\d{2} ✎ \*\*E0-02\*\* Second, renamed \(изменена в трекере: заголовок «Task E0-02» → «Second, renamed», doc docs\/30_E0_TASKS\.md → docs\/TECH_DEBT\.md\)$/,
    );
  });

  it("set --title alone keeps the doc and journals only the title", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Second, renamed\n",
    );
    const result = scratch.run(["set", "E0-02", "--title", "Second, renamed"]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.read(TRACKER)).toContain('"doc": "30_E0_TASKS.md"');
    expect(scratch.read(TRACKER)).toContain('"title": "Second, renamed"');
    expect(scratch.read(WORKLOG).trimEnd().split("\n").at(-1)).toMatch(
      /^- \d{4}-\d{2}-\d{2} ✎ \*\*E0-02\*\* Second, renamed \(изменена в трекере: заголовок «Task E0-02» → «Second, renamed»\)$/,
    );
    expect(scratch.run(["render", "--check"]).status).toBe(0);
  });

  it("set --doc alone keeps the title and journals only the doc", () => {
    scratch.write("TECH_DEBT.md", "### E0-02. Task E0-02\n");
    const result = scratch.run(["set", "E0-02", "--doc", "TECH_DEBT.md"]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.read(TRACKER)).toContain('"title": "Task E0-02"');
    expect(scratch.read(WORKLOG).trimEnd().split("\n").at(-1)).toMatch(
      /^- \d{4}-\d{2}-\d{2} ✎ \*\*E0-02\*\* Task E0-02 \(изменена в трекере: doc docs\/30_E0_TASKS\.md → docs\/TECH_DEBT\.md\)$/,
    );
    expect(scratch.run(["render", "--check"]).status).toBe(0);
  });

  it.each([
    [
      "a flag in place of the title",
      ["set", "E0-01", "--title", "--doc", "TECH_DEBT.md"],
      "--title needs a value",
    ],
    ["--doc last", ["set", "E0-01", "--doc"], "--doc needs a value"],
    ["--title last", ["set", "E0-01", "--title"], "--title needs a value"],
    [
      "a misspelt flag in place of the title",
      ["set", "E0-01", "--title", "--dco", "TECH_DEBT.md"],
      "--title needs a value",
    ],
    [
      "set, a flag in place of the id",
      ["set", "--title", "Task E0-01"],
      "task id required, got the flag --title",
    ],
    ["add, --doc last", ["add", "E0-03", "t", "--doc"], "--doc needs a value"],
    [
      "add, a flag in place of the title",
      ["add", "E0-03", "--epic", "E0"],
      "title required, got the flag --epic",
    ],
    [
      "add, a flag in place of the id",
      ["add", "--epic", "E0", "t"],
      "task id required, got the flag --epic",
    ],
  ])("refuses %s, nothing written", (_, args, why) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(why);
  });

  it("takes a title that only starts with --, in set and in add", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. --- draft\n",
    );
    const set = scratch.run(["set", "E0-02", "--title", "--- draft"]);
    expect(set.status, set.stderr).toBe(0);
    const add = scratch.run(["add", "E0-03", "--- draft"]);
    expect(add.status, add.stderr).toBe(0);
    const titles = scratch.tasks().map((entry) => entry.title);
    expect(titles).toEqual(["Task E0-01", "--- draft", "--- draft"]);
  });

  it("set names a doc gone from disk instead of throwing, nothing written", () => {
    rmSync(join(scratch.root, "docs", "30_E0_TASKS.md"));
    const result = scratch.refused(["set", "E0-02", "--title", "Renamed"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'doc "30_E0_TASKS.md" names no file: docs/30_E0_TASKS.md is not on disk',
    );
    expect(result.stderr).not.toContain("ENOENT");
  });

  it.each([
    [
      "an id out of the grammar",
      ["add", "TASK-1", "t"],
      'id "TASK-1" is neither E<n>-<n>[A-Z...] nor ADHOC-<yyyymmdd>-<n>',
    ],
    [
      "an epic out of the grammar",
      ["add", "E0-03", "t", "--epic", "e"],
      'epic "E" is neither E<n> nor ADHOC',
    ],
    [
      "an epic other than the one of the id",
      ["add", "E0-03", "t", "--epic", "E1"],
      "epic E1 does not go with the id E0-03",
    ],
    [
      "the epic ADHOC for a task of an epic",
      ["add", "E0-03", "t", "--epic", "ADHOC"],
      "epic ADHOC does not go with the id E0-03",
    ],
    [
      "an epic for a task of the owner",
      ["add", "ADHOC-20261102-1", "t", "--epic", "E0"],
      "epic E0 does not go with the id ADHOC-20261102-1",
    ],
    [
      "a dependency not in the tracker",
      ["add", "E0-03", "t", "--deps", "E0-01,E9-99"],
      "--deps names tasks that are not in the tracker: E9-99",
    ],
    [
      "a dependency on itself",
      ["add", "E0-03", "t", "--deps", "E0-03"],
      "--deps names tasks that are not in the tracker: E0-03",
    ],
  ])("add refuses %s, as the schema does, nothing written", (_, args, why) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(why);
  });

  it("add takes a task of the owner, and the schema takes what it wrote", () => {
    const result = scratch.run([
      "add",
      "ADHOC-20261102-1",
      "Owner task",
      "--deps",
      "E0-01",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().at(-1)).toMatchObject({
      id: "ADHOC-20261102-1",
      epic: "ADHOC",
      deps: ["E0-01"],
    });
  });

  it("add takes --epic in any case, as the epic of the id", () => {
    const result = scratch.run(["add", "E0-03", "Third", "--epic", "e0"]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().at(-1)).toMatchObject({ id: "E0-03", epic: "E0" });
  });

  it("render lists a task of the owner in the status, under its epic", () => {
    const added = scratch.run(["add", "ADHOC-20261102-1", "Owner task"]);
    expect(added.status, added.stderr).toBe(0);
    const status = scratch.read(STATUS);
    expect(status).toContain("### ADHOC. Задачи владельца");
    expect(status).toContain("**ADHOC** Задачи владельца");
    expect(status).toContain(
      "| ⬜ | [ADHOC-20261102-1](00_STATUS.md#adhoc-20261102-1-owner-task) | Owner task |",
    );
  });

  it("start of a task of the owner names no section it does not have", () => {
    expect(scratch.run(["add", "ADHOC-20261102-1", "Owner task"]).status).toBe(
      0,
    );
    const result = scratch.run(["start", "ADHOC-20261102-1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "ADHOC-20261102-1 started — spec: the title, no section of its own",
    );
    expect(result.stdout).not.toContain("###");
  });

  it("start of a task of a document names its section", () => {
    const result = scratch.run(["start", "E0-02"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "E0-02 started — spec: docs/30_E0_TASKS.md (### E0-02)",
    );
  });

  it("set refuses the default document for a task of an epic, nothing written", () => {
    const result = scratch.refused(["set", "E0-02", "--doc", DEFAULT_DOC]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `--doc ${DEFAULT_DOC} is for a task of the owner (ADHOC-<yyyymmdd>-<n>) only: E0-02 keeps a document with its section`,
    );
  });

  it("set takes the default document for a task of the owner", () => {
    scratch.write("TECH_DEBT.md", "### ADHOC-20261102-1. Owner task\n");
    const added = scratch.run([
      "add",
      "ADHOC-20261102-1",
      "Owner task",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(added.status, added.stderr).toBe(0);
    const result = scratch.run([
      "set",
      "ADHOC-20261102-1",
      "--doc",
      DEFAULT_DOC,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().at(-1)?.doc).toBe(DEFAULT_DOC);
  });

  it("add without --doc gives the default document", () => {
    const result = scratch.run(["add", "E0-03", "Third"]);
    expect(result.status, result.stderr).toBe(0);
    const added = scratch.tasks().find((entry) => entry.id === "E0-03");
    expect(added?.doc).toBe(DEFAULT_DOC);
    expect(scratch.run(["render", "--check"]).status).toBe(0);
  });

  it("add takes a doc whose section is written first", () => {
    scratch.write("TECH_DEBT.md", "### E0-03. Third\n");
    const result = scratch.run([
      "add",
      "E0-03",
      "Third",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.run(["render", "--check"]).status).toBe(0);
  });

  it("add refuses a doc with no section of the task, nothing written", () => {
    const result = scratch.refused([
      "add",
      "E0-03",
      "Third",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'no section "### E0-03. ..." in docs/TECH_DEBT.md: write the section "### E0-03. Third" in docs/TECH_DEBT.md first, then add the task',
    );
  });

  it("add refuses a title that is not that of the section, and names the title to give add", () => {
    scratch.write("TECH_DEBT.md", "### E0-03. Third of all\n");
    const result = scratch.refused([
      "add",
      "E0-03",
      "Third",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'give add the title of the section, "Third of all", or retitle the section',
    );
    expect(result.stderr).not.toContain("give set");
  });

  it("set --title refuses a title that is not that of the section, nothing written", () => {
    const result = scratch.refused([
      "set",
      "E0-02",
      "--title",
      "Not in the section",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the section");
    expect(result.stderr).toContain('give set E0-02 --title "Task E0-02"');
  });

  it("set --doc refuses a document with no section of the task, nothing written", () => {
    const result = scratch.refused(["set", "E0-02", "--doc", "TECH_DEBT.md"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'no section "### E0-02. ..." in docs/TECH_DEBT.md: write the section "### E0-02. Task E0-02" in docs/TECH_DEBT.md first, or give --doc the document that has it',
    );
  });

  it("render --check names a task whose section was retitled", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Something else\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("whose section is not where");
    expect(result.stderr).toContain("E0-02: title");
    expect(result.stderr).not.toContain("E0-01: ");
  });

  it("render --check refuses a section whose heading has markup", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Task E0-02 ###\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'E0-02: the section "### E0-02. Task E0-02 ###" of docs/30_E0_TASKS.md has a closing sequence of #',
    );
  });

  it("render --check refuses a section whose anchor another heading has", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Task E0-02\n\n## E0-02 Task E0-02\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'E0-02: the anchor "#e0-02-task-e0-02" of the section "### E0-02. Task E0-02" is that of 2 headings',
    );
  });

  it("add refuses a heading with markup and set one whose anchor another heading has, nothing written", () => {
    scratch.write("TECH_DEBT.md", "### E0-03. Third <b>x</b>\n");
    const add = scratch.refused([
      "add",
      "E0-03",
      "Third <b>x</b>",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(add.status).toBe(1);
    expect(add.stderr).toContain("has inline HTML (<)");
    scratch.write(
      "TECH_DEBT.md",
      "### E0-02. Task E0-02\n\n# E0-02. Task E0-02\n",
    );
    const set = scratch.refused(["set", "E0-02", "--doc", "TECH_DEBT.md"]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain("is that of 2 headings of docs/TECH_DEBT.md");
  });

  it("render --check refuses two sections of one task", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Task E0-02\n\n### E0-02. Task E0-02\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'E0-02: 2 sections "### E0-02. ..." in docs/30_E0_TASKS.md: keep one of them',
    );
  });

  it("render --check does not take the section of E0-0222 for that of E0-02", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-0222. Task E0-02\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("E0-02: no section");
  });

  it("render --check finds a section in a CRLF document, and gives its title without the line end", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "# doc\r\n\r\n### E0-01. Task E0-01\r\n\r\n### E0-02. Something else\r\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("E0-01: ");
    expect(result.stderr).toContain(
      'E0-02: title "Task E0-02" does not match the section "### E0-02. Something else" of docs/30_E0_TASKS.md',
    );
    expect(result.stderr).toContain(
      'give set E0-02 --title "Something else", or retitle the section',
    );
  });

  it("render --check names the documents first, the sections second, the status last", () => {
    const tasks = [task("E0-01", "30_E0_TASKS.md"), task("E0-02", "NOPE.md")];
    writeFileSync(
      join(scratch.root, TRACKER),
      `${JSON.stringify(tasks, null, 2)}\n`,
    );
    scratch.write("30_E0_TASKS.md", "### E0-01. Something else\n");
    const check = (): string => {
      const result = scratch.run(["render", "--check"]);
      expect(result.status).toBe(1);
      return result.stderr;
    };
    // All three wrong: the status is stale for the tracker written above.
    const documents = check();
    expect(documents).toContain("names documents that are not there");
    expect(documents).not.toContain("whose section");
    expect(documents).not.toContain("stale");
    scratch.write("NOPE.md", "### E0-02. Task E0-02\n");
    const sections = check();
    expect(sections).toContain("whose section is not where");
    expect(sections).not.toContain("stale");
    scratch.write("30_E0_TASKS.md", "### E0-01. Task E0-01\n");
    expect(check()).toContain("docs/00_STATUS.md is stale");
  });

  it("render --check wants no section of a task of the default document", () => {
    const own = scratchTracker([task("E0-01", DEFAULT_DOC)], []);
    try {
      expect(own.read("docs/00_STATUS.md")).not.toContain("### E0-01.");
      expect(own.run(["render", "--check"]).status).toBe(0);
    } finally {
      own.cleanup();
    }
  });

  it("render --check refuses a tracker naming a document that is not there", () => {
    const tasks = [
      task("E0-01", "30_E0_TASKS.md"),
      task("E0-02", "docs/30_E0_TASKS.md"),
    ];
    writeFileSync(
      join(scratch.root, TRACKER),
      `${JSON.stringify(tasks, null, 2)}\n`,
    );
    // The status in sync with the tracker: the only thing wrong is the doc.
    expect(scratch.run(["render"]).status).toBe(0);
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names documents that are not there");
    expect(result.stderr).toContain("E0-02: doc");
  });

  it("add refuses a doc before the id is looked at", () => {
    const result = scratch.refused([
      "add",
      "E0-01",
      "x",
      "--doc",
      "docs/TECH_DEBT.md",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("starts with docs/");
  });

  it.each([
    ["docs/TECH_DEBT.md", "starts with docs/"],
    ["NOPE.md", "names no file"],
    ["../x.md", "has a . or .. segment"],
    ["tech_debt.md", "the case counts"],
  ])("set refuses %s before the id is looked at", (doc, why) => {
    const result = scratch.refused(["set", "NO-SUCH-TASK", "--doc", doc]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(why);
  });

  it.each([
    ["the title it has", ["set", "E0-02", "--title", "Task E0-02"]],
    ["the doc it has", ["set", "E0-02", "--doc", "30_E0_TASKS.md"]],
    [
      "both it has",
      ["set", "E0-02", "--title", "Task E0-02", "--doc", "30_E0_TASKS.md"],
    ],
  ])("set refuses %s, nothing written", (_, args) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nothing to change: E0-02 already has that title and doc",
    );
  });

  it("set journals only the value that changes", () => {
    scratch.write("TECH_DEBT.md", "### E0-02. Task E0-02\n");
    const result = scratch.run([
      "set",
      "E0-02",
      "--title",
      "Task E0-02",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.read(WORKLOG).trimEnd().split("\n").at(-1)).toMatch(
      /\(изменена в трекере: doc docs\/30_E0_TASKS\.md → docs\/TECH_DEBT\.md\)$/,
    );
  });

  it("set asks for something to set", () => {
    const result = scratch.refused(["set", "E0-01"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing to set");
  });

  it("set refuses an empty title", () => {
    const result = scratch.refused(["set", "E0-01", "--title", " "]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title is empty");
  });

  it.each([
    ["a line feed", "Task\nE0-01"],
    ["a carriage return", "Task\rE0-01"],
  ])("set refuses a title with %s", (_, title) => {
    const result = scratch.refused(["set", "E0-01", "--title", title]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title has a line break");
  });

  it.each(["", " "])("add refuses an empty title %j", (title) => {
    const result = scratch.refused(["add", "E0-03", title]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title is empty");
  });

  it.each([
    ["a line feed", "Task\nE0-03"],
    ["a carriage return", "Task\rE0-03"],
  ])("add refuses a title with %s", (_, title) => {
    const result = scratch.refused(["add", "E0-03", title]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title has a line break");
  });
});
