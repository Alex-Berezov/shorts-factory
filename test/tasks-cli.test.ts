import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  cpSync,
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
import { DEFAULT_DOC } from "../scripts/lib/tracker-doc.mjs";
import { writeTrackerTree } from "../scripts/lib/tracker-fixture.mjs";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";
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
  writeTrackerTree(root, tasks, { docs });
  const write = (doc: string, text: string): void =>
    writeFileSync(join(root, "docs", doc), text);
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

/**
 * The commands of `ON_NODE_ALONE` in scripts/tasks.mjs, read from the source:
 * the one list of the commands that run without the packages of the root, so
 * the cases below hold every other command of the switch to the refusal.
 */
function onNodeAlone(): string[] {
  const list = /^const ON_NODE_ALONE = \[([^\]]*)\];/m.exec(
    readRepoFile("scripts/tasks.mjs"),
  )?.[1];
  if (list === undefined) {
    throw new Error("scripts/tasks.mjs: no const ON_NODE_ALONE = [...];");
  }
  return [...list.matchAll(/"([a-z-]+)"/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/** The packages scripts/ imports by a bare specifier (`from "gemoji"`). */
function barePackagesOfScripts(): string[] {
  const names = new Set<string>();
  for (const file of repoFilesUnder("scripts")) {
    if (!file.endsWith(".mjs")) continue;
    const source = readRepoFile(file);
    for (const match of source.matchAll(
      /^import [^;]*? from "([^".][^"]*)";/gm,
    )) {
      const name = match[1];
      if (name !== undefined && !name.startsWith("node:")) names.add(name);
    }
  }
  return [...names].sort();
}

/** The arguments each command that needs the packages of the root runs with. */
const NEEDS_PACKAGES: Record<string, string[]> = {
  start: ["start", "E0-01"],
  done: ["done", "E0-01"],
  block: ["block", "E0-01", "a reason"],
  unblock: ["unblock", "E0-01"],
  todo: ["todo", "E0-01"],
  render: ["render"],
  add: ["add", "E0-02", "Task E0-02", "--doc", "30_E0_TASKS.md"],
  set: ["set", "E0-01", "--title", "Other"],
};
const ALONE_ARGS: Record<string, string[]> = {
  next: ["next"],
  list: ["list"],
  show: ["show", "E0-01"],
};

/**
 * A fresh clone or worktree before `pnpm install`: the script and its
 * modules copied where no node_modules is found above them - checked, not
 * assumed: Node looks for a package in every directory up to the root of the
 * disk, and a `node_modules` above the temporary directory would let the
 * cases pass on the packages of another tree. The commands of `ON_NODE_ALONE`
 * run; every other one says which package is not installed, with no path of
 * the checkout, and writes nothing. A module of the tracker that is not
 * there is another refusal: `pnpm install` would not bring it back.
 */
describe("tasks.mjs without the packages of the root", () => {
  let scratch: Scratch;
  let code: string;
  beforeAll(() => {
    scratch = scratchTracker(
      [task("E0-01", "30_E0_TASKS.md")],
      ["30_E0_TASKS.md"],
    );
    code = mkdtempSync(join(tmpdir(), "sf-tracker-code-"));
    cpSync(join(repoRoot, "scripts"), join(code, "scripts"), {
      recursive: true,
    });
  });
  afterAll(() => {
    scratch.cleanup();
    rmSync(code, { recursive: true, force: true });
  });
  // NODE_PATH is read by require, not by import; it is cleared all the same.
  const { NODE_PATH: _, ...env } = process.env;
  const runIn = (dir: string, args: string[]) =>
    spawnSync(
      process.execPath,
      [join(dir, "scripts", "tasks.mjs"), `--root=${scratch.root}`, ...args],
      { encoding: "utf8", env, timeout: RUN_TIMEOUT_MS },
    );
  const run = (args: string[]) => runIn(code, args);
  /** Runs `args` and holds the tracker, the status and the journal to what they were. */
  const refused = (dir: string, args: string[]) => {
    const before = [TRACKER, STATUS, WORKLOG].map(scratch.read);
    const result = runIn(dir, args);
    expect([TRACKER, STATUS, WORKLOG].map(scratch.read)).toEqual(before);
    return result;
  };

  it("runs where no package of scripts/ is found", () => {
    const packages = barePackagesOfScripts();
    expect(packages).toEqual(
      expect.arrayContaining(["gemoji", "github-slugger", "markdown-it"]),
    );
    const probe = join(code, "scripts", "lib", "found-packages.mjs");
    writeFileSync(
      probe,
      `for (const name of ${JSON.stringify(packages)}) {\n  try { await import(name); console.log(name); } catch {}\n}\n`,
    );
    const found = spawnSync(process.execPath, [probe], {
      encoding: "utf8",
      env,
      timeout: RUN_TIMEOUT_MS,
    });
    rmSync(probe);
    expect(found.status, found.stderr).toBe(0);
    expect(
      found.stdout,
      `packages found from ${code}: a node_modules above it, and the cases below would not run without them`,
    ).toBe("");
  });

  it("holds every command of the script to one of the two lists", () => {
    const alone = onNodeAlone();
    expect([...alone].sort()).toEqual(Object.keys(ALONE_ARGS).sort());
    expect(
      caseLabels()
        .filter((label) => !alone.includes(label))
        .sort(),
    ).toEqual(Object.keys(NEEDS_PACKAGES).sort());
  });

  it.each(Object.values(ALONE_ARGS))("runs %s", (...args) => {
    const result = run(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("E0-01");
  });

  it.each([...Object.values(NEEDS_PACKAGES), ["render", "--check"]])(
    "refuses %s, naming the package to install, nothing written",
    (...args) => {
      const result = refused(code, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        new RegExp(
          `^error: ${args[0]} needs the package (gemoji|github-slugger|markdown-it) of the root, which is not installed: run pnpm install; next, list, show run without them\\n$`,
        ),
      );
      expect(result.stderr).not.toContain(code);
    },
  );

  /**
   * A copy of scripts/ with stand-ins of the packages of the root beside it,
   * `spoil` run on it before `start`: what is refused is what `spoil` took
   * away, not a package that is missing.
   */
  const startWithout = (spoil: (dir: string) => void) => {
    const partial = mkdtempSync(join(tmpdir(), "sf-tracker-code-"));
    try {
      cpSync(join(repoRoot, "scripts"), join(partial, "scripts"), {
        recursive: true,
      });
      for (const [name, source] of [
        ["gemoji", "export const gemoji = [];\n"],
        [
          "github-slugger",
          "export default class {\n  slug(text) {\n    return text;\n  }\n}\n",
        ],
        ["markdown-it", "export default class {}\n"],
      ] as const) {
        const dir = join(partial, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name, type: "module", main: "index.js" }),
        );
        writeFileSync(join(dir, "index.js"), source);
      }
      spoil(partial);
      const result = refused(partial, ["start", "E0-01"]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(partial);
      return result.stderr;
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  };

  it("refuses a command when a module of the tracker is not there, without pnpm install", () => {
    expect(
      startWithout((dir) =>
        rmSync(join(dir, "scripts", "lib", "markdown.mjs")),
      ),
    ).toBe(
      "error: start cannot load scripts/lib/tracker-doc.mjs: scripts/lib/markdown.mjs is not there, and the scripts of the tracker need it - restore it from git\n",
    );
  });

  it("refuses a command when a file of a package installed in part is not there, with pnpm install", () => {
    expect(
      startWithout((dir) =>
        rmSync(join(dir, "node_modules", "gemoji", "index.js")),
      ),
    ).toBe(
      "error: start needs the packages of the root, and node_modules/gemoji/index.js of one is not there: run pnpm install; next, list, show run without them\n",
    );
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
      "give add the title of the section, or retitle the section\n  the title of the section: Third of all\n",
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
    expect(result.stderr).toContain(
      "give the same set the title of the section with --title in place of the one given, or retitle the section\n  the title of the section: Task E0-02\n",
    );
  });

  it("set --title with another title than the section names the title of the section verbatim, which set takes", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Second, as written\n",
    );
    const given = ["set", "E0-02", "--title", "Second written"];
    const result = scratch.refused(given);
    expect(result.status).toBe(1);
    // The title as data, after its label, to the end of its line.
    const named = /^ {2}the title of the section: (.*)$/m.exec(
      result.stderr,
    )?.[1];
    expect(named).toBe("Second, as written");
    // The fix: the title named in place of the one given.
    const fixed = scratch.run(["set", "E0-02", "--title", named ?? ""]);
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")?.title).toBe(
      "Second, as written",
    );
  });

  it.each([
    ["--title", ["set", "E0-02", "--title", "Task E0-02", "--title", "Other"]],
    ["--est", ["set", "E0-02", "--est", "1 д", "--est", "2 д"]],
    ["--doc", ["add", "E0-03", "Third", "--doc", "A.md", "--doc", "B.md"]],
  ])("refuses %s given twice, nothing written", (flag, args) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${flag} is given twice: give it once`);
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
    // The last line names every kind of fix a task above can have, the
    // title on a line of its own among them.
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
      "each task names its fix: the section to write or the one of them to keep, the heading to write as plain text or to give a text of its own, or the title to give, which the line after it holds",
    );
  });

  it("render --check refuses a section whose heading has markup", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Task E0-02 _x_\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'E0-02: the section "### E0-02. Task E0-02 _x_" of docs/30_E0_TASKS.md has emphasis (_)',
    );
  });

  it("render --check refuses a section whose anchor an earlier heading has, and takes one after it", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n## E0-02 Task E0-02\n\n### E0-02. Task E0-02\n",
    );
    const result = scratch.run(["render", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'E0-02: GitHub gives the section "### E0-02. Task E0-02" of docs/30_E0_TASKS.md the anchor "#e0-02-task-e0-02-1"',
    );
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Task E0-02\n\n## E0-02 Task E0-02\n",
    );
    const after = scratch.run(["render", "--check"]);
    expect(after.status, after.stderr).toBe(0);
  });

  it("add refuses a heading with markup and set one whose anchor an earlier heading has, nothing written", () => {
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
      "# E0-02. Task E0-02\n\n### E0-02. Task E0-02\n",
    );
    const set = scratch.refused(["set", "E0-02", "--doc", "TECH_DEBT.md"]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain(
      'GitHub gives the section "### E0-02. Task E0-02" of docs/TECH_DEBT.md the anchor "#e0-02-task-e0-02-1"',
    );
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
    // The title on a line of its own, without the CR.
    expect(result.stderr).toContain(
      "give set E0-02 --title the title of the section, or retitle the section\n  the title of the section: Something else\n",
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
    ["the deps it has", ["set", "E0-02", "--deps", ""]],
    ["the estimate it has", ["set", "E0-02", "--est", "1 д"]],
  ])("set refuses %s, nothing written", (_, args) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nothing to change: E0-02 already has the values given",
    );
  });

  it("set writes the deps and the estimate, renders the status and journals both", () => {
    const result = scratch.run([
      "set",
      "E0-02",
      "--deps",
      "e0-01",
      "--est",
      "0.5-2 д",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")).toMatchObject(
      { deps: ["E0-01"], estimate: "0.5-2 д", estimate_days: 2 },
    );
    // The deps cell of the row of E0-02, not any mention of E0-01.
    const row = scratch
      .read(STATUS)
      .split("\n")
      .find((line) => line.startsWith("| ⬜ | [E0-02]("));
    expect(row?.split(" | ")[4]).toBe("⬜E0-01");
    expect(scratch.read(WORKLOG).trimEnd().split("\n").at(-1)).toMatch(
      /^- \d{4}-\d{2}-\d{2} ✎ \*\*E0-02\*\* Task E0-02 \(изменена в трекере: зависимости «—» → «E0-01», оценка «1 д» → «0\.5-2 д»\)$/,
    );
    expect(scratch.run(["render", "--check"]).status).toBe(0);
    // "" clears them.
    const cleared = scratch.run(["set", "E0-02", "--deps", ""]);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")?.deps).toEqual(
      [],
    );
  });

  it.each([
    [
      "deps not in the tracker",
      ["set", "NO-SUCH-TASK", "--deps", "E0-01,E9-99"],
      "--deps names tasks that are not in the tracker: E9-99",
    ],
    [
      "the task itself in its deps",
      ["set", "E0-02", "--deps", "E0-01,e0-02"],
      "--deps makes a cycle of dependencies, E0-02 → E0-02: no task of it can start",
    ],
    ["--est last", ["set", "E0-02", "--est"], "--est needs a value"],
  ])("set refuses %s, nothing written", (_, args, why) => {
    const result = scratch.refused(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(why);
  });

  it("set refuses deps that make a cycle of two, nothing written", () => {
    expect(scratch.run(["set", "E0-01", "--deps", "E0-02"]).status).toBe(0);
    const result = scratch.refused(["set", "E0-02", "--deps", "E0-01"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "error: --deps makes a cycle of dependencies, E0-02 → E0-01 → E0-02: no task of it can start\n",
    );
  });

  it("set refuses deps that make a cycle of three, and takes a chain", () => {
    const three = scratchTracker(
      [
        task("E0-01", "30_E0_TASKS.md"),
        task("E0-02", "30_E0_TASKS.md"),
        task("E0-03", "30_E0_TASKS.md"),
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      expect(three.run(["set", "E0-02", "--deps", "E0-01"]).status).toBe(0);
      expect(three.run(["set", "E0-03", "--deps", "E0-02"]).status).toBe(0);
      const result = three.refused(["set", "E0-01", "--deps", "E0-03"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--deps makes a cycle of dependencies, E0-01 → E0-03 → E0-02 → E0-01",
      );
    } finally {
      three.cleanup();
    }
  });

  it("add refuses deps that make a cycle with a task that names it, nothing written", () => {
    // A tracker where E0-01 already waits for E0-03, a task not there yet.
    writeFileSync(
      join(scratch.root, TRACKER),
      `${JSON.stringify(
        [
          { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-03"] },
          task("E0-02", "30_E0_TASKS.md"),
        ],
        null,
        2,
      )}\n`,
    );
    const result = scratch.refused([
      "add",
      "E0-03",
      "Task E0-03",
      "--doc",
      "30_E0_TASKS.md",
      "--deps",
      "E0-01",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--deps makes a cycle of dependencies, E0-03 → E0-01 → E0-03",
    );
  });

  it("add takes a task without deps where the tracker has a cycle of others", () => {
    // A tracker a merge left with E0-01 and E0-02 waiting for each other.
    writeFileSync(
      join(scratch.root, TRACKER),
      `${JSON.stringify(
        [
          { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-02"] },
          { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01"] },
        ],
        null,
        2,
      )}\n`,
    );
    const add = scratch.run(["add", "E0-99", "x"]);
    expect(add.status, add.stderr).toBe(0);
    expect(scratch.tasks().map((entry) => entry.id)).toContain("E0-99");
  });

  it("set refuses a cycle that closes through the task", () => {
    const four = scratchTracker(
      [
        { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-02"] },
        { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01"] },
        task("E0-03", "30_E0_TASKS.md"),
        { ...task("E0-04", "30_E0_TASKS.md"), deps: ["E0-03"] },
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      const result = four.refused(["set", "E0-03", "--deps", "E0-04"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--deps makes a cycle of dependencies, E0-03 → E0-04 → E0-03",
      );
    } finally {
      four.cleanup();
    }
  });

  it("set takes deps that reach a cycle of others", () => {
    // E0-01 and E0-02 wait for each other; the cycle is not through E0-03.
    const four = scratchTracker(
      [
        { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-02"] },
        { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01"] },
        task("E0-03", "30_E0_TASKS.md"),
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      const taken = four.run(["set", "E0-03", "--deps", "E0-01"]);
      expect(taken.status, taken.stderr).toBe(0);
      expect(four.tasks().find((entry) => entry.id === "E0-03")?.deps).toEqual([
        "E0-01",
      ]);
    } finally {
      four.cleanup();
    }
  });

  it("set refuses a cycle through the task that the walk meets after a cycle of others", () => {
    // E0-03 waits for E0-01 first, of the cycle E0-01 ↔ E0-02, and then for
    // E0-04, which waits for E0-03: the cycle of others is met first.
    const five = scratchTracker(
      [
        { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-02"] },
        { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01"] },
        task("E0-03", "30_E0_TASKS.md"),
        { ...task("E0-04", "30_E0_TASKS.md"), deps: ["E0-03"] },
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      const result = five.refused(["set", "E0-03", "--deps", "E0-01,E0-04"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--deps makes a cycle of dependencies, E0-03 → E0-04 → E0-03",
      );
    } finally {
      five.cleanup();
    }
  });

  it("set takes another estimate of a task of a cycle, its deps given as they are", () => {
    // A tracker a merge left with E0-01 and E0-02 waiting for each other.
    const two = scratchTracker(
      [
        { ...task("E0-01", "30_E0_TASKS.md"), deps: ["E0-02"] },
        { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01"] },
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      const result = two.run([
        "set",
        "E0-01",
        "--deps",
        "E0-02",
        "--est",
        "2 д",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(two.tasks().find((entry) => entry.id === "E0-01")).toMatchObject({
        deps: ["E0-02"],
        estimate: "2 д",
      });
    } finally {
      two.cleanup();
    }
  });

  it("set writes a dependency given twice once", () => {
    const result = scratch.run(["set", "E0-02", "--deps", "E0-01,e0-01"]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")?.deps).toEqual(
      ["E0-01"],
    );
    expect(scratch.read(WORKLOG).trimEnd().split("\n").at(-1)).toContain(
      "зависимости «—» → «E0-01»",
    );
  });

  it("set writes the deps of a task that has one of them twice once, a change", () => {
    const twice = scratchTracker(
      [
        task("E0-01", "30_E0_TASKS.md"),
        { ...task("E0-02", "30_E0_TASKS.md"), deps: ["E0-01", "E0-01"] },
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      const result = twice.run(["set", "E0-02", "--deps", "E0-01"]);
      expect(result.status, result.stderr).toBe(0);
      expect(twice.tasks().find((entry) => entry.id === "E0-02")?.deps).toEqual(
        ["E0-01"],
      );
      expect(twice.read(WORKLOG).trimEnd().split("\n").at(-1)).toContain(
        "зависимости «E0-01, E0-01» → «E0-01»",
      );
    } finally {
      twice.cleanup();
    }
  });

  it("set takes the deps it has in another order for no change", () => {
    const three = scratchTracker(
      [
        task("E0-01", "30_E0_TASKS.md"),
        task("E0-02", "30_E0_TASKS.md"),
        task("E0-03", "30_E0_TASKS.md"),
      ],
      ["30_E0_TASKS.md"],
    );
    try {
      expect(three.run(["set", "E0-03", "--deps", "E0-01,E0-02"]).status).toBe(
        0,
      );
      const result = three.refused(["set", "E0-03", "--deps", "E0-02,E0-01"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "nothing to change: E0-03 already has the values given",
      );
    } finally {
      three.cleanup();
    }
  });

  it.each([
    ["an empty estimate", "", "--est is empty"],
    ["an estimate of blanks", " ", "--est is empty"],
    ["a line feed", "1\nд", "--est has a line break"],
    ["a carriage return", "1\rд", "--est has a line break"],
  ])("set and add refuse %s, nothing written", (_, est, why) => {
    const set = scratch.refused(["set", "E0-02", "--est", est]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain(why);
    const add = scratch.refused([
      "add",
      "E0-03",
      "Task E0-03",
      "--doc",
      "30_E0_TASKS.md",
      "--est",
      est,
    ]);
    expect(add.status).toBe(1);
    expect(add.stderr).toContain(why);
  });

  it("set and add take an estimate with a | in its note, which the cell of the status escapes", () => {
    const result = scratch.run(["set", "E0-02", "--est", "1 д (a | b)"]);
    expect(result.status, result.stderr).toBe(0);
    const row = scratch
      .read(STATUS)
      .split("\n")
      .find((line) => line.startsWith("| ⬜ | [E0-02]("));
    expect(row).toContain("1 д (a \\| b)");
    const add = scratch.run([
      "add",
      "E0-03",
      "Task E0-03",
      "--est",
      "1 д (a | b)",
    ]);
    expect(add.status, add.stderr).toBe(0);
  });

  it.each([
    ["a comma for the fraction", "0,5 д"],
    ["a comma in a range", "1,5-2 д"],
    ["weeks", "1-2 нед"],
    ["hours", "2 h"],
    ["no number", "д"],
    ["no unit", "1"],
    ["text after the unit", "1 д и ещё"],
    ["a number in the note only", "д (2 д)"],
    ["a blank at the start", " 1 д"],
    ["a second estimate after its note", "1 д (a) 3 д (b)"],
    ["parentheses inside its note", "1 д (a (b) c)"],
    ["an empty note", "1 д ()"],
    ["a note of blanks only", "1 д ( )"],
    ["an empty note after a range", "1-2 д()"],
  ])("set and add refuse an estimate with %s, nothing written", (_, est) => {
    const why = `--est "${est}" is not an estimate in days`;
    const set = scratch.refused(["set", "E0-02", "--est", est]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain(why);
    const add = scratch.refused(["add", "E0-03", "Task E0-03", "--est", est]);
    expect(add.status).toBe(1);
    expect(add.stderr).toContain(why);
  });

  it.each([
    ["a dash", "2-1 д", "1-2 д"],
    ["an en dash and blanks", "1.5 – 0.5 д", "0.5-1.5 д"],
    ["a note", "2-1 д (монтаж)", "1-2 д (монтаж)"],
  ])(
    "set and add refuse a range from more days to less with %s, and name it the other way, nothing written",
    (_, est, other) => {
      const why = `--est "${est}" is a range from more days to less: give it as "${other}"`;
      const set = scratch.refused(["set", "E0-02", "--est", est]);
      expect(set.status).toBe(1);
      expect(set.stderr).toContain(why);
      const add = scratch.refused(["add", "E0-03", "Task E0-03", "--est", est]);
      expect(add.status).toBe(1);
      expect(add.stderr).toContain(why);
      // The range named is one set takes, its note kept.
      const taken = scratch.run(["set", "E0-02", "--est", other]);
      expect(taken.status, taken.stderr).toBe(0);
      expect(
        scratch.tasks().find((entry) => entry.id === "E0-02")?.estimate,
      ).toBe(other);
    },
  );

  it.each([
    ["an equal range", "1-1 д", 1],
    ["one number", "1.5 д", 1.5],
    ["a range with a dash", "0.5-2 д", 2],
    ["a range with an en dash and blanks", "0.5 – 1 д", 1],
    ["a note with numbers in it", "1 д (2–3 дня)", 1],
    ["none", "?", null],
  ])("set sums the days of an estimate of %s", (_, est, days) => {
    const result = scratch.run(["set", "E0-02", "--est", est]);
    expect(result.status, result.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")).toMatchObject(
      { estimate: est, estimate_days: days },
    );
  });

  it("add takes every estimate of the tracker of the repository, with the days it has", () => {
    const known = new Map(
      readTracker().map((entry) => [entry.estimate, entry.estimate_days]),
    );
    expect(known.size).toBeGreaterThan(1);
    let n = 10;
    for (const [est, days] of known) {
      n += 1;
      const id = `E0-${n}`;
      const result = scratch.run(["add", id, `Task ${id}`, "--est", est]);
      expect(result.status, `${est}: ${result.stderr}`).toBe(0);
      expect(
        scratch.tasks().find((entry) => entry.id === id)?.estimate_days,
        est,
      ).toBe(days);
    }
  });

  it.each([
    ["a blank at the start", " Task E0-02"],
    ["a blank at the end", "Task E0-02 "],
    ["a tab at the end", "Task E0-02\t"],
  ])("set and add refuse a title with %s, nothing written", (_, title) => {
    const why = "title starts or ends with a blank";
    const set = scratch.refused(["set", "E0-02", "--title", title]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain(why);
    const add = scratch.refused(["add", "E0-03", title, "--doc", "A.md"]);
    expect(add.status).toBe(1);
    expect(add.stderr).toContain(why);
  });

  it.each([
    ["a blank at the start", " Owner task"],
    ["a blank at the end", "Owner task "],
    ["a tab at the end", "Owner task\t"],
  ])(
    "add and set take a title with %s for a task of docs/00_STATUS.md, which has no section",
    (_, title) => {
      const added = scratch.run(["add", "ADHOC-20261102-1", title]);
      expect(added.status, added.stderr).toBe(0);
      expect(scratch.tasks().at(-1)?.title).toBe(title);
      const retitled = `${title}2`;
      const set = scratch.run(["set", "ADHOC-20261102-1", "--title", retitled]);
      expect(set.status, set.stderr).toBe(0);
      expect(scratch.tasks().at(-1)?.title).toBe(retitled);
    },
  );

  it("set refuses a title with a blank at the end for a task of docs/00_STATUS.md sent to a document with a section", () => {
    expect(scratch.run(["add", "ADHOC-20261102-1", "Owner task"]).status).toBe(
      0,
    );
    scratch.write("TECH_DEBT.md", "### ADHOC-20261102-1. Owner task\n");
    const result = scratch.refused([
      "set",
      "ADHOC-20261102-1",
      "--title",
      "Owner task ",
      "--doc",
      "TECH_DEBT.md",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title starts or ends with a blank");
  });

  it("set --title on a section with a blank entity at the end of its title tells to write the heading, and done so names a title set takes", () => {
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Second&#32;\n",
    );
    const given = ["set", "E0-02", "--title", "Other"];
    const result = scratch.refused(given);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'the section "### E0-02. Second&#32;" of docs/30_E0_TASKS.md has a blank entity at the end of its title, which no title given to the tracker has: write the heading as plain text',
    );
    expect(result.stderr).not.toContain("the title of the section:");
    // The fix as written: the heading as plain text, the same set again.
    scratch.write(
      "30_E0_TASKS.md",
      "### E0-01. Task E0-01\n\n### E0-02. Second\n",
    );
    const again = scratch.refused(given);
    expect(again.stderr).not.toContain("has a blank entity");
    const named = /^ {2}the title of the section: (.*)$/m.exec(
      again.stderr,
    )?.[1];
    expect(named).toBe("Second");
    const fixed = scratch.run(["set", "E0-02", "--title", named ?? ""]);
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  it("set --doc to a document whose section has another title tells to give the same set with --title", () => {
    scratch.write("TECH_DEBT.md", "### E0-02. Second, as written\n");
    const given = [
      "set",
      "E0-02",
      "--doc",
      "TECH_DEBT.md",
      "--deps",
      "E0-01",
      "--est",
      "2 д",
    ];
    const result = scratch.refused(given);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "give the same set --title with the title of the section too, or retitle the section\n  the title of the section: Second, as written\n",
    );
    // By the fix, the same command with the title writes every value given.
    const fixed = scratch.run([...given, "--title", "Second, as written"]);
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(scratch.tasks().find((entry) => entry.id === "E0-02")).toMatchObject(
      {
        title: "Second, as written",
        doc: "TECH_DEBT.md",
        deps: ["E0-01"],
        estimate: "2 д",
      },
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
