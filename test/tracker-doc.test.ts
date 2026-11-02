import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  DEFAULT_DOC,
  badDocs,
  badSections,
  docProblem,
  sectionIndex,
  sectionProblem,
  slug,
} from "../scripts/lib/tracker-doc.mjs";
import { readTracker } from "./tracker.js";

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
    ).toContain("give set E0-03 --title 'Third task', or retitle");
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
    ["emphasis of _", "Fix _the_ gate", "emphasis (_)"],
    ["strong emphasis of __", "Fix __init__ gate", "emphasis (_)"],
    ["emphasis of _ around a word", "Fix _snake_", "emphasis (_)"],
    ["inline HTML", "Fix <b>the</b> gate", "inline HTML (<)"],
    ["a link", "Fix [the gate](x.md)", "a link ([)"],
    ["an image", "Fix ![the gate](x.png)", "an image (![)"],
    ["strikethrough", "Fix ~~the~~ gate", "strikethrough (~)"],
    ["a gemoji", "Fix :tada: gate", "an emoji (:tada:)"],
    ["a gemoji with a sign", "Fix :+1: gate", "an emoji (:+1:)"],
    ["a gemoji after a colon", "Fix a:zzzq:tada: gate", "an emoji (:tada:)"],
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
    ["_ opening with nothing to close it", "Fix _x gate"],
    ["_ closing with nothing opened", "Fix x_ gate"],
    ["a code span with HTML", "Fix `Result<T>` gate"],
    ["a code span with _", "Fix `__dirname` gate"],
    ["a code span with an entity", "Fix `&amp;` gate"],
    ["a code span with a gemoji", "Fix `:tada:` gate"],
    ["an escaped *", "Fix \\*a\\* gate"],
    ["a colon pair that is no gemoji", "Gate test:int: runs"],
    ["a `<` that opens no tag", "Fix a < b gate"],
    ["a [ that opens no link", "Fix [a] gate"],
  ])("takes %s in its heading, which is no markup", (_, title) => {
    writeFileSync(join(docs, "PLAIN.md"), `### E0-05. ${title}\n`);
    expect(
      sectionProblem({ id: "E0-05", title, doc: "PLAIN.md" }, docs, "check"),
    ).toBeUndefined();
  });

  /** Headings with the anchor of `### E0-05. Fifth task`, of every kind. */
  const sameAnchor = [
    ["a heading of another level", "## E0-05. Fifth task"],
    ["a heading that differs only in its signs", "#### E0-05: Fifth task!"],
    ["a heading with a closing sequence", "# E0-05. Fifth task #"],
    ["a setext heading of the second level", "E0-05. Fifth task\n---"],
    ["a setext heading of the first level", "E0-05. Fifth task\n==="],
    ["a heading in a quote", "> ## E0-05. Fifth task"],
    ["a heading in a list item", "- #### E0-05. Fifth task"],
    ["a heading with a tab", "#\tE0-05. Fifth task"],
  ] as const;

  it.each(sameAnchor)(
    "is refused when %s before it has its anchor, GitHub numbering the section",
    (_, other) => {
      writeFileSync(
        join(docs, "TWICE.md"),
        `${other}\n\n### E0-05. Fifth task\n`,
      );
      expect(
        sectionProblem(five("Fifth task", "TWICE.md"), docs, "check"),
      ).toBe(
        'GitHub gives the section "### E0-05. Fifth task" of docs/TWICE.md the anchor "#e0-05-fifth-task-1", an earlier heading having "#e0-05-fifth-task": the link of docs/00_STATUS.md lands on that one; give each of them a text of its own',
      );
    },
  );

  it.each(sameAnchor)(
    "takes %s after it with its anchor, which GitHub numbers instead",
    (_, other) => {
      writeFileSync(
        join(docs, "TWICE.md"),
        `### E0-05. Fifth task\n\n${other}\n`,
      );
      expect(
        sectionProblem(five("Fifth task", "TWICE.md"), docs, "check"),
      ).toBeUndefined();
    },
  );

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
    expect(problem).toContain("give set E0-02 --title 'Second task'");
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
      "give add the title of the section, 'Second task', or retitle the section",
    ],
    [
      "set",
      "another title",
      { ...second("A.md"), title: "Other" },
      "give the same set --title 'Second task' too, or retitle the section",
    ],
  ] as const)("tells %s what to do about %s", (command, _, task, fix) => {
    const problem = sectionProblem(task, docs, command);
    expect(problem?.endsWith(fix), problem).toBe(true);
    if (command === "add") expect(problem).not.toContain("set E0-02");
  });

  const five = (title: string, doc: string) => ({
    id: "E0-05",
    title,
    doc,
  });

  it.each([
    ["an indent of one blank", " ### E0-02. Second task"],
    ["an indent of three blanks", "   ### E0-02. Second task"],
    ["a tab after the hashes", "###\tE0-02. Second task"],
    ["a closing sequence", "### E0-02. Second task ###"],
    ["a quote", "> ### E0-02. Second task"],
    ["a quote in a quote", "> > ### E0-02. Second task"],
    ["a list item", "- ### E0-02. Second task"],
    ["a numbered list item", "1. ### E0-02. Second task"],
  ])("is found with %s", (_, line) => {
    writeFileSync(join(docs, "SHAPE.md"), `# a\n\n${line}\n`);
    expect(sectionProblem(second("SHAPE.md"), docs, "check")).toBeUndefined();
  });

  it.each([
    ["an indent of four blanks, a block of code", "    ### E0-02. Second task"],
    ["an indent of a tab, a block of code", "\t### E0-02. Second task"],
    ["an HTML comment", "<!--\n### E0-02. Second task\n-->"],
    ["an HTML comment closed on its line", "<!-- ### E0-02. Second task -->"],
    ["a script block", "<script>\n### E0-02. Second task\n</script>"],
    ["a pre block", "<pre>\n### E0-02. Second task\n</pre>"],
    ["a div block", "<div>\n### E0-02. Second task\n\nafter"],
    ["a setext heading", "E0-02. Second task\n------"],
    ["a heading of the first level", "# E0-02. Second task"],
    ["a heading of the fourth level", "#### E0-02. Second task"],
  ])("is not found in %s", (_, block) => {
    writeFileSync(join(docs, "SHAPE.md"), `# a\n\n${block}\n`);
    expect(sectionProblem(second("SHAPE.md"), docs, "check")).toContain(
      'no section "### E0-02. ..." in docs/SHAPE.md',
    );
  });

  it("is found after an HTML comment that is closed, and in a block that ends at a blank line", () => {
    writeFileSync(
      join(docs, "SHAPE.md"),
      "<!--\nx\n-->\n\n<div>\nx\n\n### E0-02. Second task\n",
    );
    expect(sectionProblem(second("SHAPE.md"), docs, "check")).toBeUndefined();
  });

  it("is not refused for the anchor of a heading in an HTML comment or a block of code", () => {
    writeFileSync(
      join(docs, "TWICE.md"),
      "<!--\n## E0-05. Fifth task\n-->\n\n```\n## E0-05. Fifth task\n```\n\n### E0-05. Fifth task\n",
    );
    expect(
      sectionProblem(five("Fifth task", "TWICE.md"), docs, "check"),
    ).toBeUndefined();
  });

  it("takes an entity and a closing sequence as the renderer does, by the anchor of the rendered text", () => {
    writeFileSync(
      join(docs, "RENDERED.md"),
      "### E0-05. Fix &amp; &#35;gate ###\n",
    );
    expect(
      sectionProblem(five("Fix & #gate", "RENDERED.md"), docs, "check"),
    ).toBeUndefined();
    // The title with the entity in it is another anchor, and the title to give
    // is the text as rendered.
    expect(
      sectionProblem(five("Fix &amp; &#35;gate", "RENDERED.md"), docs, "check"),
    ).toContain("give set E0-05 --title 'Fix & #gate'");
  });

  it.each([
    ["the id in a code span", "### `E0-05`. Bar", "Bar"],
    ["the dot of the id escaped", "### E0-05\\. Bar", "Bar"],
    ["the id and its dot in a code span", "### `E0-05.` Bar", "Bar"],
  ])(
    "gives the title after the id with %s, and that title is taken",
    (_, line, title) => {
      writeFileSync(join(docs, "SPAN.md"), `${line}\n`);
      // A word of letters alone needs no quotes in any shell.
      expect(sectionProblem(five("Other", "SPAN.md"), docs, "check")).toBe(
        `title "Other" does not match the section "### E0-05. ${title}" of docs/SPAN.md: the link of docs/00_STATUS.md misses it; give set E0-05 --title ${title}, or retitle the section`,
      );
      expect(
        sectionProblem(five(title, "SPAN.md"), docs, "check"),
      ).toBeUndefined();
    },
  );

  it.each([
    [
      "a command substitution and a double quote",
      "### E0-05. a &#36;(id) &quot;b `c`",
      `a $(id) "b c`,
      `'a $(id) "b c'`,
    ],
    ["a single quote", "### E0-05. it's", "it's", `'it'\\''s'`],
    ["a backslash", "### E0-05. a \\\\ b", "a \\ b", `'a \\ b'`],
  ])(
    "quotes the title to give for the shell, with %s in it",
    (_, line, title, quoted) => {
      writeFileSync(join(docs, "SHELL.md"), `${line}\n`);
      expect(sectionProblem(five("Other", "SHELL.md"), docs, "set")).toContain(
        `give the same set --title ${quoted} too, or retitle the section`,
      );
      expect(
        sectionProblem(five(title, "SHELL.md"), docs, "check"),
      ).toBeUndefined();
    },
  );

  it.each([
    ["a heading", "## Notes :tada:\n\n### E0-05. Fifth task\n", "Notes :tada:"],
    [
      "a heading after another one",
      "# a\n\n## Done :+1:\n\n### E0-05. Fifth task\n",
      "Done :+1:",
    ],
  ])(
    "is refused when %s before it has an emoji, whose anchor is not worked out",
    (_, text, source) => {
      writeFileSync(join(docs, "EMOJI.md"), text);
      expect(
        sectionProblem(five("Fifth task", "EMOJI.md"), docs, "check"),
      ).toBe(
        `the heading "${source}" of docs/EMOJI.md has an emoji (${source.slice(source.indexOf(":"))}), whose anchor is not worked out: the anchor GitHub gives the section "### E0-05. Fifth task" may be another; write that heading as plain text`,
      );
    },
  );

  it("takes a heading with an emoji after it, which numbers no anchor before it", () => {
    writeFileSync(
      join(docs, "EMOJI.md"),
      "### E0-05. Fifth task\n\n## Итоги :tada:\n",
    );
    expect(
      sectionProblem(five("Fifth task", "EMOJI.md"), docs, "check"),
    ).toBeUndefined();
  });

  it("takes a heading with a colon pair that is no emoji next to the section", () => {
    writeFileSync(
      join(docs, "EMOJI.md"),
      "## Gate test:int: runs\n\n### E0-05. Fifth task\n",
    );
    expect(
      sectionProblem(five("Fifth task", "EMOJI.md"), docs, "check"),
    ).toBeUndefined();
  });

  it.each([
    ["a tab", "### E0-05.\tFifth task"],
    ["a no-break space", "### E0-05.\u00a0Fifth task"],
    ["two blanks", "### E0-05.  Fifth task"],
    ["nothing", "### E0-05."],
  ])(
    "is not found when %s follows the dot, and the fix is to write it",
    (_, line) => {
      writeFileSync(join(docs, "BLANK.md"), `# a\n\n${line}\n`);
      expect(
        sectionProblem(five("Fifth task", "BLANK.md"), docs, "check"),
      ).toBe(
        'no section "### E0-05. ..." in docs/BLANK.md: write the section "### E0-05. Fifth task" in docs/BLANK.md, or give set E0-05 --doc the document that has it',
      );
    },
  );

  it("is refused when an earlier heading has the anchor GitHub numbered for another", () => {
    // GitHub: "e0-05-x", then "e0-05-x-1" for the second, then the section
    // "e0-05-x-1" is taken and gets "e0-05-x-1-1".
    writeFileSync(
      join(docs, "NUMBERED.md"),
      "## E0-05: x\n\n## E0-05: x\n\n### E0-05. x 1\n",
    );
    expect(sectionProblem(five("x 1", "NUMBERED.md"), docs, "check")).toBe(
      'GitHub gives the section "### E0-05. x 1" of docs/NUMBERED.md the anchor "#e0-05-x-1-1", an earlier heading having "#e0-05-x-1": the link of docs/00_STATUS.md lands on that one; give each of them a text of its own',
    );
  });

  it("is found in a document with a byte order mark", () => {
    writeFileSync(join(docs, "MARKED.md"), "\uFEFF### E0-05. Fifth task\n");
    expect(
      sectionProblem(five("Fifth task", "MARKED.md"), docs, "check"),
    ).toBeUndefined();
  });

  it("counts a two-line setext heading by its lines joined", () => {
    writeFileSync(
      join(docs, "TWICE.md"),
      "E0-05. Fifth\ntask\n---\n\n### E0-05. Fifthtask\n",
    );
    expect(
      sectionProblem(five("Fifthtask", "TWICE.md"), docs, "check"),
    ).toContain('the anchor "#e0-05-fifthtask-1", an earlier heading having');
  });

  it.each([
    ["a line feed", "&#10;"],
    ["a carriage return", "&#13;"],
  ])(
    "is refused with the entity of %s in its heading, and names no title to give",
    (_, entity) => {
      writeFileSync(join(docs, "BREAK.md"), `### E0-05. Fifth${entity}task\n`);
      expect(
        sectionProblem(five("Fifth task", "BREAK.md"), docs, "check"),
      ).toBe(
        `the section "### E0-05. Fifth${entity}task" of docs/BREAK.md has a line break entity, write the heading as plain text`,
      );
    },
  );

  it("reads a document once for any number of its tasks", () => {
    const read: string[] = [];
    const bad = badSections(
      [second("A.md"), third("A.md"), five("x", "A.md"), second("CRLF.md")],
      docs,
      (path) => {
        read.push(path);
        return sectionIndex(readFileSync(path, "utf8"));
      },
    );
    expect(read).toEqual([join(docs, "A.md"), join(docs, "CRLF.md")]);
    expect(bad).toHaveLength(2);
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
    // Not a letter or a digit: a number of another kind (superscript, fraction) is cut.
    ["E0-12A", "x² ½ a‿b ＿", "e0-12a-x--a‿b-＿"],
    // A letter number is kept, and lowercased.
    ["E0-12A", "aⅠ b", "e0-12a-aⅰ-b"],
  ])("of %s is the one GitHub gives", (id, title, anchor) => {
    expect(slug(id, title)).toBe(anchor);
  });
});
