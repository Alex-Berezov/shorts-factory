import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  UnreadableFileError,
  isGone,
  isNoListedFile,
  isNotFile,
  readIfFile,
  readTrackedFiles,
  trackedFiles,
} from "../scripts/lib/files.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { LOOKUP, enumerationViolations } from "./enumeration.js";
import { failingCall } from "./failing-call.js";
import { gitScratch } from "./git-fixture.js";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";

/**
 * The one answer of the root scripts to "is that path gone"
 * (`scripts/lib/files.mjs`), each branch on its own: the gates that walk a
 * tree, run a binary or read a file that may be absent take it from there -
 * and its one listing of the files of a repository (`trackedFiles`).
 */
const FILES_MODULE = join(repoRoot, "scripts", "lib", "files.mjs");

const fixture = gitScratch("sf-files-");
const scratch = fixture.dir;

/** A name for the program of one injection (`failingCall`), new for each. */
let injections = 0;
const injection = (what: string): string => {
  injections += 1;
  return `${what}-${injections}`;
};

const failed = (code: string): Error =>
  Object.assign(new Error(`${code}: injected`), { code });

describe("isGone", () => {
  it.each([
    ["ENOENT", true, failed("ENOENT")],
    ["EPERM", false, failed("EPERM")],
    ["EBUSY", false, failed("EBUSY")],
    ["EACCES", false, failed("EACCES")],
    ["an error without a code", false, new Error("ENOENT")],
    ["a value that is not an error", false, { code: "ENOENT" }],
  ] as const)("takes %s for gone: %s", (_what, gone, error) => {
    expect(isGone(error)).toBe(gone);
  });
});

describe("isNotFile", () => {
  it.each([
    ["ENOENT", true, failed("ENOENT")],
    ["ENOTDIR", true, failed("ENOTDIR")],
    ["EPERM", false, failed("EPERM")],
    ["EACCES", false, failed("EACCES")],
    ["EISDIR", false, failed("EISDIR")],
    ["a value that is not an error", false, { code: "ENOTDIR" }],
  ] as const)("takes %s for no file: %s", (_what, notFile, error) => {
    expect(isNotFile(error)).toBe(notFile);
  });
});

describe("isNoListedFile", () => {
  it.each([
    ["ENOENT", true, failed("ENOENT")],
    ["ENOTDIR", true, failed("ENOTDIR")],
    ["EISDIR", true, failed("EISDIR")],
    ["EPERM", false, failed("EPERM")],
    ["EACCES", false, failed("EACCES")],
    ["EBUSY", false, failed("EBUSY")],
    ["a value that is not an error", false, { code: "EISDIR" }],
  ] as const)("takes %s for no listed file: %s", (_what, none, error) => {
    expect(isNoListedFile(error)).toBe(none);
  });
});

describe("readIfFile", () => {
  it("reads a file, and gives null for nothing or a directory there", () => {
    writeFileSync(join(scratch, "file"), "text\n");
    mkdirSync(join(scratch, "directory"));

    expect(readIfFile(join(scratch, "file"))).toBe("text\n");
    expect(readIfFile(join(scratch, "missing"))).toBeNull();
    expect(readIfFile(join(scratch, "directory"))).toBeNull();
  });

  it("throws what is not a missing file", () => {
    // A path node refuses outright: not an absent file, an error to report.
    expect(() => readIfFile("compose\0.yaml")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });

  it("throws EPERM of the disk rather than taking the file for absent", () => {
    // A child whose `fs.statSync` answers EPERM for one path, replaced before
    // `files.mjs` is imported, so its named import is the replacement.
    writeFileSync(join(scratch, "locked"), "text\n");
    const program = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const real = fs.statSync;",
      "fs.statSync = (path, ...rest) => {",
      '  if (String(path).endsWith("locked")) {',
      '    throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });',
      "  }",
      "  return real(path, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      `const { readIfFile } = await import(${JSON.stringify(pathToFileURL(FILES_MODULE).href)});`,
      "try {",
      `  const text = readIfFile(${JSON.stringify(join(scratch, "locked"))});`,
      "  console.log(`read: ${JSON.stringify(text)}`);",
      "} catch (error) {",
      "  console.log(`threw: ${error.code}`);",
      "}",
    ].join("\n");

    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { encoding: "utf8", timeout: 20_000 },
    );

    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe("threw: EPERM");
  });
});

describe("trackedFiles", () => {
  const workTree = fixture.tree;
  const git = fixture.git;

  it("lists tracked and untracked files from the root, and no ignored one", () => {
    const root = workTree("listed", {
      ".gitignore": "coverage/\n*.log\n",
      "apps/a/src/index.ts": "",
      "coverage/index.html": "",
      "debug.log": "",
      "README.md": "",
    });
    git(root, ["add", "apps"]);

    expect(trackedFiles(root).sort()).toEqual([
      ".gitignore",
      "README.md",
      "apps/a/src/index.ts",
    ]);
  });

  it("leaves out a tracked file deleted from the disk", () => {
    const root = workTree("deleted", { "a.ts": "", "b.ts": "" });
    git(root, ["add", "."]);
    rmSync(join(root, "a.ts"));

    expect(trackedFiles(root)).toEqual(["b.ts"]);
  });

  it("leaves out a tracked file under a directory a file now stands in place of", () => {
    const root = workTree("enotdir", { "a/b.ts": "", "c.ts": "" });
    git(root, ["add", "."]);
    rmSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a"), "");

    expect(trackedFiles(root).sort()).toEqual(["a", "c.ts"]);
  });

  it("leaves out a tracked file a directory took the place of, and keeps the files in it", () => {
    const root = workTree("replaced", { "a.ts": "", "c.ts": "" });
    git(root, ["add", "."]);
    rmSync(join(root, "a.ts"));
    mkdirSync(join(root, "a.ts"));
    writeFileSync(join(root, "a.ts", "d.ts"), "");

    expect(trackedFiles(root).sort()).toEqual(["a.ts/d.ts", "c.ts"]);
  });

  it("lists once a path git gives more than once, as a file in conflict", () => {
    const root = workTree("conflict", { "a.ts": "" });
    const spawn = () => ({
      status: 0,
      stdout: "a.ts\0a.ts\0a.ts\0",
      stderr: "",
    });

    expect(trackedFiles(root, { spawn })).toEqual(["a.ts"]);
  });

  /**
   * What `trackedFiles` of a child gives for `root` - `listed: [...]` or
   * `threw: <code>` - when `fs.statSync` of the child answers `code` for the
   * one path that ends in `file`, replaced before `files.mjs` is imported.
   * `keep` is the source of the predicate handed to `trackedFiles`, none by
   * default.
   */
  function listedInChild(
    root: string,
    file: string,
    code: string,
    keep?: string,
  ): string {
    const options = keep === undefined ? "" : `, { keep: ${keep} }`;
    const program = [
      `const { trackedFiles } = await import(${JSON.stringify(pathToFileURL(FILES_MODULE).href)});`,
      "try {",
      `  console.log(\`listed: \${JSON.stringify(trackedFiles(${JSON.stringify(root)}${options}))}\`);`,
      "} catch (error) {",
      "  console.log(`threw: ${error.code}`);",
      "}",
    ].join("\n");

    const child = spawnSync(
      process.execPath,
      [
        ...failingCall(scratch, injection("listed"), code, file, {
          call: "statSync",
        }),
        "--input-type=module",
        "--eval",
        program,
      ],
      { encoding: "utf8", timeout: 20_000, env: fixture.env },
    );

    expect(child.stderr).toBe("");
    return child.stdout.trim();
  }

  it.each(["EPERM", "EACCES"])(
    "throws %s of the disk on a listed file rather than leaving it out",
    (code) => {
      const root = workTree(`locked-${code}`, { "a.ts": "", "locked.ts": "" });

      expect(listedInChild(root, "locked.ts", code)).toBe(`threw: ${code}`);
    },
  );

  it("leaves out a listed file whose stat says ENOTDIR, on any platform", () => {
    // Windows answers ENOENT where Linux answers ENOTDIR for a path under a
    // file; the injected error makes the case the same on both.
    const root = workTree("stat-enotdir", { "a.ts": "", "broken.ts": "" });

    expect(listedInChild(root, "broken.ts", "ENOTDIR")).toBe(
      'listed: ["a.ts"]',
    );
  });

  it("gives only the paths keep takes", () => {
    const root = workTree("keep", { "a.ts": "", "b.md": "", "c/d.ts": "" });

    expect(
      trackedFiles(root, { keep: (path) => path.endsWith(".ts") }).sort(),
    ).toEqual(["a.ts", "c/d.ts"]);
  });

  it("never looks at a path keep leaves out: its EPERM does not fail the listing", () => {
    const root = workTree("keep-locked", { "a.ts": "", "locked.md": "" });

    expect(
      listedInChild(
        root,
        "locked.md",
        "EPERM",
        '(path) => path.endsWith(".ts")',
      ),
    ).toBe('listed: ["a.ts"]');
  });

  it("throws, with what git said, on a directory that is no work tree", () => {
    const root = join(scratch, "no-repo");
    mkdirSync(root);

    expect(() => trackedFiles(root)).toThrow(
      /git ls-files in .*no-repo failed \(exit \d+\): .*not a git repository/i,
    );
  });

  it("throws when git cannot be started", () => {
    const spawn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync git ENOENT"), {
        code: "ENOENT",
      }),
    });

    expect(() => trackedFiles(scratch, { spawn })).toThrow("git ls-files in");
    expect(() => trackedFiles(scratch, { spawn })).toThrow(
      "spawnSync git ENOENT",
    );
  });

  it("runs git without the fsmonitor of the user's config", () => {
    const calls: string[][] = [];
    const spawn = (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(trackedFiles(scratch, { spawn })).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
  });
});

describe("readTrackedFiles", () => {
  const workTree = fixture.tree;
  const git = fixture.git;
  const byPath = (
    files: Iterable<{ path: string; text: string }>,
  ): { path: string; text: string }[] =>
    [...files].sort((x, y) => x.path.localeCompare(y.path));

  it("gives the text of each listed file keep takes", () => {
    const root = workTree("read", {
      "a.ts": "A\n",
      "b.md": "B\n",
      "c/d.ts": "D\n",
    });

    expect(
      byPath(readTrackedFiles(root, { keep: (path) => path.endsWith(".ts") })),
    ).toEqual([
      { path: "a.ts", text: "A\n" },
      { path: "c/d.ts", text: "D\n" },
    ]);
  });

  it("leaves out a tracked file deleted from the disk", () => {
    const root = workTree("read-deleted", { "a.ts": "", "b.ts": "b" });
    git(root, ["add", "."]);
    rmSync(join(root, "a.ts"));

    expect([...readTrackedFiles(root)]).toEqual([{ path: "b.ts", text: "b" }]);
  });

  it("leaves out a tracked file a directory took the place of, and reads the files in it", () => {
    const root = workTree("read-replaced", { "a.ts": "", "c.ts": "c" });
    git(root, ["add", "."]);
    rmSync(join(root, "a.ts"));
    mkdirSync(join(root, "a.ts"));
    writeFileSync(join(root, "a.ts", "d.ts"), "d");

    expect(byPath(readTrackedFiles(root))).toEqual([
      { path: "a.ts/d.ts", text: "d" },
      { path: "c.ts", text: "c" },
    ]);
  });

  it("leaves out a tracked file under a directory a file now stands in place of", () => {
    const root = workTree("read-enotdir", { "a/b.ts": "", "c.ts": "c" });
    git(root, ["add", "."]);
    rmSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a"), "a");

    expect(byPath(readTrackedFiles(root))).toEqual([
      { path: "a", text: "a" },
      { path: "c.ts", text: "c" },
    ]);
  });

  /**
   * What `readTrackedFiles` of a child gives for `root` - `read: [paths]`, or
   * `threw: <code> <whether its path is the file>` - when `fs.<call>` of the
   * child answers `code` for the one path that ends in `file`, replaced
   * before `files.mjs` is imported.
   */
  function readInChild(
    root: string,
    file: string,
    code: string,
    call: "readFileSync" | "statSync",
  ): string {
    const program = [
      `const { readTrackedFiles } = await import(${JSON.stringify(pathToFileURL(FILES_MODULE).href)});`,
      "try {",
      `  const read = [...readTrackedFiles(${JSON.stringify(root)})].map(({ path }) => path).sort();`,
      "  console.log(`read: ${JSON.stringify(read)}`);",
      "} catch (error) {",
      `  console.log(\`threw: \${error.code} \${String(error.path).endsWith(${JSON.stringify(file)})}\`);`,
      "}",
    ].join("\n");

    const child = spawnSync(
      process.execPath,
      [
        ...failingCall(scratch, injection("read"), code, file, { call }),
        "--input-type=module",
        "--eval",
        program,
      ],
      { encoding: "utf8", timeout: 20_000, env: fixture.env },
    );

    expect(child.stderr).toBe("");
    return child.stdout.trim();
  }

  it.each(["EPERM", "EACCES", "EBUSY"])(
    "throws %s of the read, naming the file, rather than leaving it out",
    (code) => {
      const root = workTree(`read-locked-${code}`, {
        "a.ts": "",
        "locked.ts": "",
      });

      expect(readInChild(root, "locked.ts", code, "readFileSync")).toBe(
        `threw: ${code} true`,
      );
    },
  );

  it("touches a file once, by its read: an EPERM of stat alone does not fail it", () => {
    // A stat before the read - the way of trackedFiles - throws here.
    const root = workTree("read-stat-eperm", { "a.ts": "", "locked.ts": "" });

    expect(readInChild(root, "locked.ts", "EPERM", "statSync")).toBe(
      'read: ["a.ts","locked.ts"]',
    );
  });

  it("throws an UnreadableFileError for a file it cannot read, with the code and the file", () => {
    const root = workTree("read-unreadable", { "a.ts": "", "b.ts": "" });
    const program = [
      `const { readTrackedFiles, UnreadableFileError } = await import(${JSON.stringify(pathToFileURL(FILES_MODULE).href)});`,
      "try {",
      `  [...readTrackedFiles(${JSON.stringify(root)})];`,
      '  console.log("read");',
      "} catch (error) {",
      '  console.log(`${error instanceof UnreadableFileError} ${error.code} ${error.path.endsWith("b.ts")}`);',
      "}",
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        ...failingCall(scratch, injection("unreadable"), "EBUSY", "b.ts"),
        "--input-type=module",
        "--eval",
        program,
      ],
      { encoding: "utf8", timeout: 20_000, env: fixture.env },
    );

    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe("true EBUSY true");
  });

  it("names the root, not the command, when the spawn of git throws: no UnreadableFileError", () => {
    // An error of node may carry a `path` of its own - for a spawn, the command.
    const spawn = (): never => {
      throw Object.assign(new Error("spawnSync git EPERM"), {
        code: "EPERM",
        path: "git",
      });
    };
    let thrown: unknown;
    try {
      readTrackedFiles(scratch, { spawn });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(UnreadableFileError);
    expect(String(thrown)).toContain(
      `git ls-files in ${scratch} failed: spawnSync git EPERM`,
    );
  });

  it("reads a file when the iteration reaches it, not at the call: one text at a time, judged by the disk of that moment", () => {
    const root = workTree("read-lazy", { "a.ts": "a", "b.ts": "b" });
    git(root, ["add", "."]);
    const files = readTrackedFiles(root);

    const first = files.next();
    // Deleted after the first file was taken: the second is read only now.
    rmSync(join(root, "b.ts"));

    expect(first.value).toEqual({ path: "a.ts", text: "a" });
    expect([...files]).toEqual([]);
  });

  it("throws, with what git said, on a directory that is no work tree", () => {
    const root = join(scratch, "read-no-repo");
    mkdirSync(root);

    expect(() => readTrackedFiles(root)).toThrow(
      /git ls-files in .*read-no-repo failed \(exit \d+\): .*not a git repository/i,
    );
  });
});

/**
 * The scripts of `scripts/` that list a directory of the disk on purpose,
 * each with the one problem of the lock it is let off (the end of the
 * problem, `enumerationViolations`) and its reason: what they read is the
 * disk itself, not the files of the repository. Any other problem of the
 * same script - another lister, the same one reached another way - is not
 * let off.
 */
const SCRIPT_DISK_READS: Record<string, { problem: string; reason: string }> = {
  "scripts/lib/tracker-doc.mjs": {
    problem: ": imports readdirSync",
    reason:
      "compares the case of each name of a path under docs/ with the one the disk has - git lists the case of its index, and a disk that ignores case finds either",
  },
};

/**
 * The scripts that look a path of the repository up on the disk on purpose,
 * each with its reason. Only the lookup is let off: they list no directory.
 */
const SCRIPT_DISK_CHECKS: Record<string, string> = {
  "scripts/tasks.mjs":
    "creates docs/90_WORKLOG.md when it is not there yet, before it appends to it: a file it writes, not one it lists",
};

describe("listing through trackedFiles only", () => {
  /** The scripts the lock holds: every source file of `scripts/`. */
  const scripts = () =>
    repoFilesUnder("scripts").filter((path) => /\.[cm]?[jt]s$/.test(path));

  /** The problems of the lock in the script `path` with `text`, save the ones it is let off. */
  const problemsOf = (path: string, text: string): string[] => {
    const read = SCRIPT_DISK_READS[path]?.problem;
    const checks = Object.hasOwn(SCRIPT_DISK_CHECKS, path);
    return enumerationViolations(path, text).filter(
      (problem) =>
        !(
          (checks && problem.endsWith(LOOKUP)) ||
          (read !== undefined && problem.endsWith(read))
        ),
    );
  };

  it("holds every script of scripts/, save what each named one is let off", () => {
    expect(scripts().length).toBeGreaterThan(5);
    const problems = scripts().flatMap((path) =>
      problemsOf(path, readRepoFile(path)),
    );

    expect(problems).toEqual([]);
  });

  it("lets a script that reads the disk off its one named problem, not another", () => {
    const path = "scripts/lib/tracker-doc.mjs";
    const text = `${readRepoFile(path)}\nimport { opendirSync } from "node:fs";\n`;

    expect(problemsOf(path, text)).toEqual([
      expect.stringContaining(": imports opendirSync"),
    ]);
  });

  it("names only scripts that still list or look up the disk", () => {
    for (const [path, { problem }] of Object.entries(SCRIPT_DISK_READS)) {
      expect(
        enumerationViolations(path, readRepoFile(path)).filter((found) =>
          found.endsWith(problem),
        ),
        path,
      ).not.toEqual([]);
    }
    for (const path of Object.keys(SCRIPT_DISK_CHECKS)) {
      expect(
        enumerationViolations(path, readRepoFile(path)).filter((problem) =>
          problem.endsWith(LOOKUP),
        ),
        path,
      ).not.toEqual([]);
    }
  });

  it("refuses a lister in a script, and passes one in the script a container runs", () => {
    expect(
      enumerationViolations(
        "scripts/x.mjs",
        'import { readdirSync } from "node:fs";\nreaddirSync("apps");',
      ),
    ).toEqual([expect.stringContaining("imports readdirSync")]);
    expect(
      enumerationViolations(
        "scripts/x.mjs",
        'export const IN_IMAGE = `const { readdirSync } = require("node:fs");`;',
      ),
    ).toEqual([]);
  });
});
