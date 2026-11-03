import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  type DebtRefContext,
  debtAddresses,
  debtRefProblems,
  textOf,
} from "./debt-refs.js";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";
import { readTracker } from "./tracker.js";

/**
 * Code points at the debt table by one form: `docs/TECH_DEBT.md § <id>`, the
 * id a task of the tracker the table names as the task of a row. This is the
 * lock: any other mention of the table is refused, and so is an address the
 * table does not hold. The files read are those of `apps/`, `packages/`,
 * `scripts/`, `test/` and `.github/`; the harness (`.claude/`) is held to the
 * form by a later task (docs/TECH_DEBT.md § E0-12X).
 */
const SCOPE = ["apps", "packages", "scripts", "test", ".github"];
/** The lock itself spells the forms it refuses, as patterns and as cases. */
const SELF = new Set(["test/debt-refs.ts", "test/debt-refs.test.ts"]);
/**
 * The files that name the table as a file and not a row of it: the tracker
 * CLI and its tests, where `TECH_DEBT.md` is a document a task may name. A
 * closed list of paths, each held to still need its place.
 */
const BARE_MENTIONS = [
  "scripts/tasks.mjs",
  "scripts/lib/tracker-doc.mjs",
  "test/tasks-cli.test.ts",
  "test/tracker-doc.test.ts",
];

const TABLE = [
  "# debt",
  "",
  "| Дата | Откуда | Где | Что не так | Риск | Исход |",
  "| --- | --- | --- | --- | --- | --- |",
  "| 07.09.2026 | E0-05, решение | `x` | a | b | закрыто: E0-08 (`y`, до E0-12E) |",
  "| 20.10.2026 | E0-12J, ревью E0-12D | `z` | a | b | открыто: порядок |",
  "| 06.09.2026 | E0-02, добор | `t` | a \\| b | c | закрыто: E0-12F (d) |",
  "| 01.11.2026 | E0-13, ревью | `u` | a | b | открыто: E13-07 (CSP) |",
  "| 02.11.2026 | E0-03 | `v` | a | b | закрыто: E0-10 (e); было: открыто -> E0-14 |",
  "| 02.11.2026 | E0-03 | `w` | a | b | закрыто: ADHOC-20261102-1 (f) |",
  "",
  "| Исход | Откуда |",
  "| --- | --- |",
  "| закрыто: E0-11 | E0-03 |",
  "",
  "### E0-12X. Title",
  "",
  "```md",
  "### E0-12AK. In a block",
  "| 01.01.2026 | E0-13 | w | a | b | закрыто: E0-10 |",
  "```",
  "",
].join("\n");

const context = (bareAllowed: boolean): DebtRefContext => ({
  taskIds: new Set(
    "E0-02 E0-03 E0-05 E0-08 E0-10 E0-11 E0-12 E0-12D E0-12E E0-12F E0-12J E0-12X E0-12AK E0-13 E0-14 E13-07 ADHOC-20261102-1".split(
      " ",
    ),
  ),
  addresses: debtAddresses(TABLE),
  bareAllowed,
});

/** What is wrong with the references of the file `path` holding `bytes`. */
function fileProblems(
  path: string,
  bytes: Uint8Array,
  ids: DebtRefContext,
): string[] {
  const text = textOf(bytes);
  if (text === undefined) return [];
  return debtRefProblems(text, {
    ...ids,
    bareAllowed: BARE_MENTIONS.includes(path),
  }).map((problem) => `${path}: ${problem}`);
}

/** The paths of `allowed` that are not files of `files` or do not need the place. */
function unneededBareMentions(
  allowed: readonly string[],
  files: readonly string[],
  ids: DebtRefContext,
): string[] {
  return allowed.filter(
    (path) =>
      !files.includes(path) ||
      debtRefProblems(readRepoFile(path), { ...ids, bareAllowed: false })
        .length === 0,
  );
}

describe("the addresses of the debt table", () => {
  it("are the task of each row and each section, by the columns the header names, out of blocks of code", () => {
    expect([...debtAddresses(TABLE)].sort()).toEqual(
      [
        "ADHOC-20261102-1",
        "E0-08",
        "E0-10",
        "E0-11",
        "E0-12F",
        "E0-12J",
        "E0-12X",
        "E13-07",
      ].sort(),
    );
  });

  // The forms of the column «Исход» of docs/TECH_DEBT.md, each with the task
  // it names; an id not right after the word of the outcome is none.
  it.each([
    ["закрыто: E0-08 (до E0-12E)", "E0-08"],
    ["закрыто E0-12U (2026-10-23)", "E0-12U"],
    ["закрыто частично: E0-10 - в web", "E0-10"],
    ["частично закрыто E0-06 (круг правок 1)", "E0-06"],
    ["закрыто наполовину: E0-09 (`now()`)", "E0-09"],
    ["сужено: ресурсная часть закрыта E0-08 (x)", "E0-08"],
    ["сужено: `queues.enabled` закрыт E0-08 (x)", "E0-08"],
    ["открыто: E13-07 «Защита доступа»", "E13-07"],
    ["открыто -> E0-12V", "E0-12V"],
    ["открыто → E0-12V", "E0-12V"],
    ["переадресовано E13-07 (решение)", "E13-07"],
    ["переадресовано: E1-12 (решение)", "E1-12"],
    ["принято: E0-08 завёл вторую копию", "E0-08"],
    ["принято с условием: E0-12O (Р1)", "E0-12O"],
    ["закрыто: ADHOC-20261102-1 (x)", "ADHOC-20261102-1"],
    ["закрыто: E0-10 (x); было: открыто -> E0-14", "E0-10"],
    ["открыто: вместе с E1-12 (x)", "E0-02"],
    ["принято: в E0-04 значения", undefined],
    ["E1-12: прогнать `up`", undefined],
  ])("in the outcome %j are %j", (result, id) => {
    // The first id of the source counts only for a row open with no task.
    const table = `| Откуда | Исход |\n| --- | --- |\n| E0-02, ревью E0-12D | ${result} |\n`;
    expect([...debtAddresses(table)]).toEqual(id === undefined ? [] : [id]);
  });

  it.each([
    [
      "a comment between the header and the separator",
      "| Откуда | Исход |\n<!-- c -->\n| --- | --- |\n| x | закрыто: E0-08 |\n",
    ],
    [
      "a fenced block between the header and the separator",
      "| Откуда | Исход |\n```\nx\n```\n| --- | --- |\n| x | закрыто: E0-08 |\n",
    ],
    [
      "a comment between the separator and a row",
      "| Откуда | Исход |\n| --- | --- |\n<!-- c -->\n| x | закрыто: E0-08 |\n",
    ],
  ])("are none of a table GitHub does not render, %s", (_, table) => {
    expect([...debtAddresses(table)]).toEqual([]);
  });

  it("are read from docs/TECH_DEBT.md", () => {
    const addresses = debtAddresses(readRepoFile("docs/TECH_DEBT.md"));
    // Rows closed by E0-08 and E0-12F, and a section of the document.
    expect(addresses).toContain("E0-08");
    expect(addresses).toContain("E0-12F");
    expect(addresses).toContain("E0-12X");
  });
});

describe("a reference to the debt table", () => {
  it.each([
    ["a line number of the table", "the mistake `TECH_DEBT:114` names"],
    ["a line number after the file", "(docs/TECH_DEBT.md:114)"],
    ["a comma after TECH_DEBT", "(TECH_DEBT, E0-12Y)"],
    ["a comma after the file name", "(docs/TECH_DEBT.md, E0-09)"],
    ["a comma, wrapped", "(docs/TECH_DEBT.md,\n * 06.09.2026)"],
    [
      "a line number in front of the file",
      "Rule (e), :531 of docs/TECH_DEBT.md",
    ],
    ["a date for the id", "(docs/TECH_DEBT.md § 06.09.2026)"],
    ["an id in lowercase", "(docs/TECH_DEBT.md § e0-12x)"],
    ["an id of no task grammar", "(docs/TECH_DEBT.md § ADHOC-1)"],
    ["the table with no file", "the TECH_DEBT entry of 06.09.2026"],
    ["the section sign with no path", "(TECH_DEBT.md § E0-08)"],
  ])("refuses %s, in any file", (_, text) => {
    const refused = [expect.stringContaining("not in the one form")];
    expect(debtRefProblems(text, context(false))).toEqual(refused);
    expect(debtRefProblems(text, context(true))).toEqual(refused);
  });

  it("refuses the bare file where a row is meant", () => {
    expect(
      debtRefProblems(
        "source rebuilds them (docs/TECH_DEBT.md).",
        context(false),
      ),
    ).toEqual([expect.stringContaining("not in the one form")]);
  });

  it.each([
    ["the task that found a row another closed", "E0-05"],
    ["the prefix of the ids of the rows", "E0-12"],
    ["a task of the tracker the table does not name", "E0-13"],
    ["a task the table names only in a block of code", "E0-12AK"],
    ["an id further on in the outcome", "E0-12E"],
    ["a second id of the source of an open row", "E0-12D"],
    ["the source of an open row that names its task", "E0-13"],
    ["the task a row was open to before it closed", "E0-14"],
  ])("refuses an address to %s", (_, id) => {
    expect(
      debtRefProblems(`(docs/TECH_DEBT.md § ${id})`, context(false)),
    ).toEqual([
      `addresses ${id}, which docs/TECH_DEBT.md does not name as the task of a row or a section`,
    ]);
  });

  it.each(["E9-99", "ADHOC-20261103-1"])(
    "refuses %s, an id that is not a task of the tracker",
    (id) => {
      expect(
        debtRefProblems(`(docs/TECH_DEBT.md § ${id})`, context(false)),
      ).toEqual([`addresses ${id}, which is not a task of the tracker`]);
    },
  );

  it.each([
    ["the task that closed the row", "(docs/TECH_DEBT.md § E0-08, п.5)"],
    [
      "a reference wrapped in a comment",
      "(docs/TECH_DEBT.md\n   * § E0-08, п.5)",
    ],
    [
      "a reference wrapped in an SQL comment",
      "-- (docs/TECH_DEBT.md\n-- § E0-08, п.5)",
    ],
    ["the task that found an open row", "docs/TECH_DEBT.md § E0-12J"],
    ["a section of the document", "docs/TECH_DEBT.md § E0-12X."],
    ["the column by its name", "docs/TECH_DEBT.md § E0-11"],
    ["the task of an open row", "docs/TECH_DEBT.md § E13-07"],
    ["a task of the owner", "docs/TECH_DEBT.md § ADHOC-20261102-1, п.1"],
  ])("passes %s", (_, text) => {
    expect(debtRefProblems(text, context(false))).toEqual([]);
  });

  it.each([
    "the table `docs/TECH_DEBT.md` itself",
    "(`TECH_DEBT.md`, not `docs/TECH_DEBT.md`)",
    '["docs/TECH_DEBT.md", "starts with docs/"]',
  ])("passes the bare file %j where it is allowed", (text) => {
    expect(debtRefProblems(text, context(true))).toEqual([]);
  });

  it("names an allowed path that is not a file or no longer needs the place", () => {
    const files = ["scripts/tasks.mjs", "test/repo-files.ts"];
    expect(
      unneededBareMentions(
        ["", "test/repo-files.ts", "scripts/tasks.mjs"],
        files,
        context(false),
      ),
    ).toEqual(["", "test/repo-files.ts"]);
  });

  it.each([
    ["a migration", "packages/db/migrations/0099_x.sql", "-- TECH_DEBT:114\n"],
    [
      "a shell script",
      "scripts/x.sh",
      "#!/bin/sh\n# (docs/TECH_DEBT.md, E0-09)\n",
    ],
    [
      "a Dockerfile",
      "apps/worker/x.Dockerfile",
      "# TECH_DEBT, E0-12J\nFROM node\n",
    ],
    ["a file with no extension", "apps/worker/Dockerfile", "# TECH_DEBT:1\n"],
  ])("reads %s of the scope, whatever its name", (_, path, text) => {
    // A case outside the scope would promise more than the lock reads.
    expect(SCOPE.some((dir) => path.startsWith(`${dir}/`))).toBe(true);
    expect(
      fileProblems(path, new TextEncoder().encode(text), context(false)),
    ).toEqual([expect.stringContaining(`${path}: names the debt table`)]);
  });

  /** The bytes of `text` in UTF-8, and then those of `rest`. */
  const bytesOf = (text: string, ...rest: number[]): Uint8Array =>
    Uint8Array.from([...new TextEncoder().encode(text), ...rest]);

  /** `text` in UTF-16, little or big endian, with the byte order mark or without. */
  const utf16 = (text: string, big: boolean, mark: boolean): Uint8Array => {
    const bytes: number[] = mark ? (big ? [0xfe, 0xff] : [0xff, 0xfe]) : [];
    for (const unit of text) {
      const code = unit.charCodeAt(0);
      bytes.push(
        ...(big ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8]),
      );
    }
    return Uint8Array.from(bytes);
  };

  it.each([
    [
      "a PNG",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, ...bytesOf("TECH_DEBT:1")]),
    ],
    [
      "WebAssembly",
      Uint8Array.from([
        0,
        0x61,
        0x73,
        0x6d,
        1,
        0,
        0,
        0,
        ...bytesOf("TECH_DEBT:12"),
      ]),
    ],
    ["UTF-8 with a NUL byte", bytesOf("# TECH_DEBT:1", 0, 0x0a)],
    ["one NUL byte", Uint8Array.from([0])],
    ["UTF-16LE without a mark", utf16("# TECH_DEBT:1\n", false, false)],
    ["UTF-16BE without a mark", utf16("# TECH_DEBT:1\n", true, false)],
  ])("skips %s, a NUL byte and no mark of UTF-16, as binary", (_, bytes) => {
    expect(textOf(bytes)).toBeUndefined();
    expect(
      fileProblems("apps/web/public/x.bin", bytes, context(false)),
    ).toEqual([]);
  });

  it.each([
    ["an empty file", new Uint8Array(0), ""],
    ["one byte", bytesOf("A"), "A"],
  ])("reads %s as text", (_, bytes, text) => {
    expect(textOf(bytes)).toBe(text);
  });

  it.each([
    ["three dashes", "TECH_DEBT\n---", "TECH_DEBT ---"],
    ["a flag", "TECH_DEBT\n--flag", "TECH_DEBT --flag"],
  ])("keeps %s at the start of a line, no comment marker", (_, text, kept) => {
    expect(debtRefProblems(text, context(false))).toEqual([
      expect.stringContaining(kept),
    ]);
  });

  it.each([
    ["UTF-16LE", false],
    ["UTF-16BE", true],
  ] as const)("reads a file in %s with a mark", (_, big) => {
    expect(
      fileProblems(
        "scripts/x.ps1",
        utf16("# TECH_DEBT:1\n", big, true),
        context(false),
      ),
    ).toEqual([expect.stringContaining("scripts/x.ps1: names the debt table")]);
  });

  it.each([
    ["UTF-16LE", false],
    ["UTF-16BE", true],
  ] as const)(
    "reads a file in %s with a mark, mostly not ASCII, by the mark",
    (_, big) => {
      const text = "# Задача на будущее, долг: TECH_DEBT:1 - ещё не решено\n";
      expect(textOf(utf16(text, big, true))).toBe(text);
    },
  );

  it("holds the code of the repository to the one form", () => {
    const files = SCOPE.flatMap((dir) => repoFilesUnder(dir)).filter(
      (path) => !SELF.has(path),
    );
    // The scope is tied to the tree, not to a count: every directory of it
    // gave files, and files known to be there are among them.
    for (const dir of SCOPE) {
      expect(
        files.some((path) => path.startsWith(`${dir}/`)),
        dir,
      ).toBe(true);
    }
    for (const path of [
      "scripts/tasks.mjs",
      "test/tasks-cli.test.ts",
      "test/tracker-doc.test.ts",
      ".github/workflows/ci.yml",
      "apps/api/package.json",
      "packages/core/package.json",
    ]) {
      expect(files, path).toContain(path);
    }
    const ids: DebtRefContext = {
      taskIds: new Set(readTracker().map((task) => task.id)),
      addresses: debtAddresses(readRepoFile("docs/TECH_DEBT.md")),
      bareAllowed: false,
    };
    expect(unneededBareMentions(BARE_MENTIONS, files, ids)).toEqual([]);
    const found = files.flatMap((path) =>
      fileProblems(path, readFileSync(join(repoRoot, path)), ids),
    );
    expect(found).toEqual([]);
  });
});
