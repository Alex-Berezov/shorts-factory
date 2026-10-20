import { describe, expect, it } from "vitest";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";

/**
 * A decision record outlives the line numbers of the files it points at: a
 * reference `file:line` into the repository reads as the place of a decision
 * and, after the next edit of that file, points at a line about something
 * else. The records in `docs/adr/` name a symbol instead - a script, a key, a
 * function, a step - and this is the lock on that.
 *
 * A reference is a path followed by `:<line>` (or a range) whose path is a
 * file of the repository: the whole path from the root
 * (`apps/api/package.json:7`, `turbo.json:12`), or its tail from any directory
 * (`src/cli/migrate.ts:12`, from the root of `@sf/db`), with or without a
 * leading `./` or `../` (`./apps/api/package.json:7`). The files of the
 * repository are the list git gives, so a new top directory needs no edit
 * here. A file of a library (`fastify.js:134`, `lib/handle-request.js:35`), a
 * host and port (`localhost:5432`) and a url are not files of the repository
 * and pass.
 */
const PATH_AND_LINE =
  /(?<![\w./@:-])((?:[\w.@-]+\/)*[\w.@-]+):\d+(?:-\d+)?(?![\w/])/g;

/** The `file:line` references into the repository in `text`; `files` - its files from the root. */
function fileLineRefs(text: string, files: readonly string[]): string[] {
  const known = new Set(files);
  const isRepoFile = (written: string): boolean => {
    // `./x` and `../x` name the same file as `x` from wherever the reader is.
    const path = written.replace(/^(?:\.\.?\/)+/, "");
    return known.has(path) || files.some((file) => file.endsWith(`/${path}`));
  };
  return Array.from(text.matchAll(PATH_AND_LINE))
    .filter((match) => match[1] !== undefined && isRepoFile(match[1]))
    .map((match) => match[0]);
}

const FILES = [
  "package.json",
  "turbo.json",
  "compose.yaml",
  ".nvmrc",
  "apps/api/package.json",
  "apps/worker/src/runtime.ts",
  ".github/workflows/ci.yml",
  "infra/docker/app.Dockerfile",
  "packages/db/src/cli/migrate.ts",
  "tools/new-top/check.mjs",
];

describe("fileLineRefs", () => {
  it.each([
    [
      "a path from the root",
      "(`apps/api/package.json:7`)",
      "apps/api/package.json:7",
    ],
    [
      "a range",
      "`apps/worker/src/runtime.ts:193-200`",
      "apps/worker/src/runtime.ts:193-200",
    ],
    [
      "a hidden top directory",
      "(`.github/workflows/ci.yml:82-83`)",
      ".github/workflows/ci.yml:82-83",
    ],
    [
      "a Dockerfile",
      "`infra/docker/app.Dockerfile:56`",
      "infra/docker/app.Dockerfile:56",
    ],
    ["a file at the root", "see `turbo.json:12`", "turbo.json:12"],
    ["a file at the root without an extension", "`.nvmrc:1`", ".nvmrc:1"],
    [
      "a path from the root of a package",
      "(`src/cli/migrate.ts:12`)",
      "src/cli/migrate.ts:12",
    ],
    ["a bare file name of the repository", "`migrate.ts:12`", "migrate.ts:12"],
    [
      "a path from the root behind ./",
      "(`./apps/api/package.json:7`)",
      "./apps/api/package.json:7",
    ],
    [
      "a path behind ../",
      "`../../packages/db/src/cli/migrate.ts:12`",
      "../../packages/db/src/cli/migrate.ts:12",
    ],
    [
      "a path under a top directory no list names",
      "`tools/new-top/check.mjs:3`",
      "tools/new-top/check.mjs:3",
    ],
  ])("refuses %s", (_what, text, ref) => {
    expect(fileLineRefs(text, FILES)).toEqual([ref]);
  });

  it.each([
    ["a reference by symbol", "(`scripts.dev` в `apps/api/package.json`)"],
    [
      "a file of a library",
      "(`bodyless` в `fastify.js:134`, `lib/handle-request.js:35`)",
    ],
    [
      "a host and port",
      "`postgres://sf:sf@localhost:5432/sf`, `x@localhost:5442`, `127.0.0.1:5432`",
    ],
    ["a url", "`http://api:3001/health`"],
    [
      "a path under a directory that is not of the repository",
      "`node_modules/fastify/lib/route.js:480`",
    ],
    ["a tail that is not a whole name", "`ate.ts:12`, `json:7`"],
  ])("passes %s", (_what, text) => {
    expect(fileLineRefs(text, FILES)).toEqual([]);
  });
});

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
