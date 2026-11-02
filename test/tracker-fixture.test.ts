import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTrackerTree } from "../scripts/lib/tracker-fixture.mjs";

/**
 * The tree the tests of the CLI and the probe of the gate `tracker` write
 * (`scripts/lib/tracker-fixture.mjs`): one writer, and a `doc` the tracker
 * would not take - one that leaves the tree among them - refused before
 * anything is written.
 */
describe("the tree of the tracker fixture", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sf-tracker-fixture-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [
      "a .. segment",
      "../outside.md",
      'doc "../outside.md" has a . or .. segment: give a path from docs/ that stays in it',
    ],
    [
      "an absolute path",
      "/tmp/outside.md",
      'doc "/tmp/outside.md" is an absolute path: give a path from docs/',
    ],
    [
      "a drive",
      "C:/outside.md",
      'doc "C:/outside.md" is an absolute path: give a path from docs/',
    ],
    ["an empty doc", "", "doc is empty"],
    [
      "a backslash",
      "adr\\README.md",
      'doc "adr\\README.md" has a backslash: separate the directories with /',
    ],
    [
      "a . segment",
      "./A.md",
      'doc "./A.md" has a . or .. segment: give a path from docs/ that stays in it',
    ],
  ])(
    "refuses a doc with %s, naming the task and the reason of the tracker",
    (_, doc, reason) => {
      expect(() =>
        writeTrackerTree(root, [{ id: "E0-01", title: "x", doc }]),
      ).toThrow(`E0-01: ${reason}`);
    },
  );

  it.each([
    [
      "a .. segment",
      "../outside.md",
      'doc "../outside.md" has a . or .. segment',
    ],
    [
      "an absolute path",
      "/tmp/outside.md",
      'doc "/tmp/outside.md" is an absolute path',
    ],
  ])("refuses a document to write with %s", (_, doc, reason) => {
    expect(() =>
      writeTrackerTree(root, [{ id: "E0-01", title: "x", doc: "A.md" }], {
        docs: [doc],
      }),
    ).toThrow(`document to write: ${reason}`);
  });

  it("takes a doc whose name only starts with two dots", () => {
    writeTrackerTree(root, [{ id: "E0-01", title: "x", doc: "..notes.md" }]);
    expect(readFileSync(join(root, "docs", "..notes.md"), "utf8")).toBe(
      "# doc\n\n### E0-01. x\n",
    );
  });

  it("writes only the documents given, when they are", () => {
    const tree = mkdtempSync(join(tmpdir(), "sf-tracker-fixture-"));
    try {
      writeTrackerTree(
        tree,
        [
          { id: "E0-01", title: "x", doc: "A.md" },
          { id: "E0-02", title: "y", doc: "GONE.md" },
        ],
        { docs: ["A.md", "EMPTY.md"] },
      );
      expect(existsSync(join(tree, "docs", "A.md"))).toBe(true);
      expect(existsSync(join(tree, "docs", "GONE.md"))).toBe(false);
      expect(readFileSync(join(tree, "docs", "EMPTY.md"), "utf8")).toBe(
        "# doc\n\n",
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("writes the tracker, the section of each task and the journal", () => {
    writeTrackerTree(root, [{ id: "E0-01", title: "x", doc: "A.md" }]);
    expect(readFileSync(join(root, "docs", "A.md"), "utf8")).toBe(
      "# doc\n\n### E0-01. x\n",
    );
    expect(
      readFileSync(join(root, "docs", "tasks", "tasks.json"), "utf8"),
    ).toContain('"id": "E0-01"');
    expect(readFileSync(join(root, "docs", "90_WORKLOG.md"), "utf8")).toContain(
      "Журнал",
    );
  });
});
