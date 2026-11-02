import { describe, expect, it } from "vitest";
import { fileLineRefs } from "./file-line-refs.js";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";

/**
 * A decision record outlives the line numbers of the files it points at: a
 * reference `file:line` into the repository reads as the place of a decision
 * and, after the next edit of that file, points at a line about something
 * else. The records in `docs/adr/` name a symbol instead (see `file-line-refs.ts`
 * for what counts as a reference), and this is the lock on that.
 */
describe("docs/adr", () => {
  const records = repoFilesUnder("docs/adr").filter((path) =>
    path.endsWith(".md"),
  );
  const files = repoFilesUnder(".");

  it("reads every record the index lists, and the files of the repository", () => {
    // Nothing read would pass the case below on nothing: the records on disk
    // are exactly those of the table of docs/adr/README.md, plus the index.
    const listed = Array.from(
      readRepoFile("docs/adr/README.md").matchAll(
        /^\| `(\d{4}-[\w-]+\.md)` \|/gm,
      ),
      (match) => `docs/adr/${match[1]}`,
    );
    expect(listed.length).toBeGreaterThan(0);
    expect([...records].sort()).toEqual(
      [...listed, "docs/adr/README.md"].sort(),
    );
    expect(files).toContain("package.json");
    expect(files).toContain("docs/adr/README.md");
  });

  it("points at no line of a file of the repository", () => {
    const found = records.flatMap((path) =>
      fileLineRefs(readRepoFile(path), files).map((ref) => `${path}: ${ref}`),
    );
    expect(found).toEqual([]);
  });
});
