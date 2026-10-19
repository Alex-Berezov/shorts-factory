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
import { z } from "zod";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { badDocs, docProblem } from "../scripts/lib/tracker-doc.mjs";
import { readRepoFile, readRepoJson } from "./repo-files.js";

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

/** A task of a made-up tracker, as docs/tasks/tasks.json holds it. */
function task(id: string, doc: string, deps: string[] = []) {
  return {
    id,
    epic: "E0",
    title: `Task ${id}`,
    estimate: "1 д",
    estimate_days: 1,
    deps,
    doc,
    status: "todo",
  };
}

const TRACKER = "docs/tasks/tasks.json";
const STATUS = "docs/00_STATUS.md";
const WORKLOG = "docs/90_WORKLOG.md";

/**
 * A tree of its own for the CLI (`--root=<dir>`): docs/tasks/tasks.json with
 * `tasks`, the documents `docs` names, a journal and docs/00_STATUS.md
 * rendered by the CLI itself. Every case that writes, and every case that
 * must not, runs here: a regression that writes where it should refuse
 * changes this copy, never the tracker of the repository.
 */
function scratchTracker(tasks: unknown[], docs: string[]) {
  const root = mkdtempSync(join(tmpdir(), "sf-tracker-"));
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(join(root, TRACKER), `${JSON.stringify(tasks, null, 2)}\n`);
  writeFileSync(join(root, WORKLOG), "# Журнал работ\n\n");
  for (const doc of docs) writeFileSync(join(root, "docs", doc), "# doc\n");
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
    const raw = readRepoJson("docs/tasks/tasks.json");
    const tasks = z
      .array(z.object({ id: z.string(), doc: z.unknown() }))
      .parse(raw);
    // Nothing parsed would pass on nothing.
    expect(tasks).not.toHaveLength(0);
    expect(badDocs(tasks, join(repoRoot, "docs"))).toEqual([]);
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
    const result = scratch.run([
      "set",
      "E0-02",
      "--title",
      "Second, renamed",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const tasks = z
      .array(z.object({ id: z.string(), title: z.string(), doc: z.string() }))
      .parse(JSON.parse(scratch.read(TRACKER)));
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
      /^- \d{4}-\d{2}-\d{2} ✎ \*\*E0-02\*\* Second, renamed \(изменена в трекере: заголовок, doc → docs\/TECH_DEBT\.md\)$/,
    );
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
