import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  SOURCE_EXTENSIONS,
  breaksRule,
  isSource,
} from "../scripts/lib/search-list.mjs";
import { type Injected, failingCall } from "./failing-call.js";
import { gitScratch } from "./git-fixture.js";

/**
 * The gate against the 100-unit YouTube search call, run as CI and the gate
 * hook run it - a child process - on trees made for each case, each a git
 * work tree (`git init`, nothing added): the gate scans the files git lists,
 * tracked or untracked and not ignored. A gate that could not list or read
 * what it was to scan must say so (exit 2), not pass. A failure of
 * `readFileSync` on one file is made by a module preloaded into the child
 * (`--import`), which replaces the function of `node:fs` for that one file -
 * and, for the error a file being deleted gives on Windows, removes it first
 * and makes the child see `win32` as its platform. Only `ENOENT` is a file
 * gone. A line passes only as a line of a comment carrying the mark
 * `no-search-list: allowed` (`scripts/lib/search-list.mjs`).
 */
const SCRIPT = join(repoRoot, "scripts", "check-no-search-list.mjs");

/** The banned call, put together so this file does not carry it whole. */
const BANNED_CALL = ["youtube", "search", "list"].join(".");

const fixture = gitScratch("sf-no-search-list-");
const scratch = fixture.dir;
const files = fixture.files;
const tree = fixture.tree;

/** A run of the gate takes well under a second; a hung one is killed. */
const TIMEOUT_MS = 20_000;

function gate(
  root: string,
  preload: string[] = [],
  env: NodeJS.ProcessEnv = fixture.env,
) {
  return spawnSync(process.execPath, [...preload, SCRIPT, root], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env,
  });
}

/**
 * Node flags that make `fs.readFileSync` (or `call`) throw an error with
 * `code` for the one file whose path ends in `file`; everything else is
 * read as it is (`failingCall`, `test/failing-call.ts`).
 */
function failing(
  name: string,
  code: string,
  file: string,
  injected: Injected = {},
): string[] {
  return failingCall(scratch, name, code, file, injected);
}

const CLEAN = {
  "apps/a/src/index.ts": "export const a = 1;\n",
  "packages/b/src/index.ts": "export const b = 2;\n",
  "scripts/c.mjs": "export const c = 3;\n",
  "test/d.test.ts": "export const d = 4;\n",
};

/** A line that names the call, in a comment that bans it. */
const BANNING_COMMENT = `// NEVER call ${BANNED_CALL}: it costs 100 units.\n`;

describe("check-no-search-list", () => {
  it("fails on the banned call and names the file and line", () => {
    const root = tree("hit", {
      ...CLEAN,
      "packages/b/src/sync.ts": `const x = 1;\nawait ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/b/src/sync.ts:2");
  });

  it("fails on the banned call in a test of the root project", () => {
    const root = tree("hit-test", {
      ...CLEAN,
      "test/x.test.ts": `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/x.test.ts:1");
  });

  it.each([
    [
      "a comment that bans it with never",
      "packages/b/src/quota.ts",
      BANNING_COMMENT,
    ],
    ["a .mts file", "apps/a/src/sync.mts", `await ${BANNED_CALL}({});\n`],
    ["a .cts file", "apps/a/src/sync.cts", `await ${BANNED_CALL}({});\n`],
    ["a .jsx file", "apps/a/src/view.jsx", `await ${BANNED_CALL}({});\n`],
    [
      "a file at the root",
      "vitest.extra.config.ts",
      `await ${BANNED_CALL}({});\n`,
    ],
    [
      "a hook of the harness",
      ".claude/hooks/x.js",
      `await ${BANNED_CALL}({});\n`,
    ],
  ])("fails on the banned call in %s", (_what, path, text) => {
    const root = tree(`hit-${path.replaceAll(/[/.]/g, "-")}`, {
      ...CLEAN,
      [path]: text,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:1`);
  });

  it.each([
    ["tools/sync.mjs"],
    ["infra/scripts/sync.ts"],
    [".claude/commands/sync.js"],
    ["docs/examples/sync.cjs"],
  ])("fails on the banned call in %s, a directory no list names", (path) => {
    const root = tree(`hit-${path.replaceAll(/[/.]/g, "-")}`, {
      ...CLEAN,
      [path]: `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:1`);
  });

  it("passes a line comment marked as allowed, and only that line", () => {
    const root = tree("marked", {
      ...CLEAN,
      "packages/b/src/quota.ts": [
        `${BANNING_COMMENT.trimEnd()} no-search-list: allowed`,
        BANNING_COMMENT.trimEnd(),
        `  // never ${BANNED_CALL} - no-search-list: allowed`,
        "",
      ].join("\n"),
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/b/src/quota.ts:2");
    for (const line of [1, 3]) {
      expect(result.stderr).not.toContain(`packages/b/src/quota.ts:${line}`);
    }
  });

  it("reads a file with CRLF line ends: the marked line comment passes, the call fails", () => {
    const root = tree("marked-crlf", {
      ...CLEAN,
      "packages/b/src/quota.ts": [
        `// never ${BANNED_CALL} - no-search-list: allowed`,
        `await ${BANNED_CALL}({});`,
        "",
      ].join("\r\n"),
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/b/src/quota.ts:2");
    expect(result.stderr).not.toContain("packages/b/src/quota.ts:1");
  });

  it("passes a line with the mark and no call", () => {
    const root = tree("mark-only", {
      ...CLEAN,
      "packages/b/src/x.ts": "export const y = 1; // no-search-list: allowed\n",
    });

    const result = gate(root);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (5 files)");
  });

  it("does not scan a file that is no source, the call in it or not", () => {
    const root = tree("not-source", {
      ...CLEAN,
      "docs/sync.md": `await ${BANNED_CALL}({});\n`,
      "packages/b/config.json": `{ "call": "${BANNED_CALL}" }\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it.each([
    ["after the call", `await ${BANNED_CALL}({}); // no-search-list: allowed`],
    [
      "in a string of the line",
      `const why = "// no-search-list: allowed"; await ${BANNED_CALL}({});`,
    ],
    [
      "after a block comment closed before the call",
      `/* x */ await ${BANNED_CALL}({}); // no-search-list: allowed`,
    ],
    [
      "after the end of a block comment the call follows",
      ` * x */ await ${BANNED_CALL}({}); // no-search-list: allowed`,
    ],
    [
      "after the end of a block comment at the head of the line",
      `*/ await ${BANNED_CALL}({}); // no-search-list: allowed`,
    ],
    [
      "after a block comment one star opens and closes",
      `/*/ ${BANNED_CALL}({}) // no-search-list: allowed`,
    ],
    [
      "on a line going on with a product",
      `  * (await ${BANNED_CALL}({})).data; // no-search-list: allowed`,
    ],
  ])("fails on a line of code with the mark %s", (_what, line) => {
    const root = tree(`marked-code-${_what.replaceAll(" ", "-")}`, {
      ...CLEAN,
      "packages/b/src/sync.ts": `${line}\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/b/src/sync.ts:1");
  });

  it.each([
    ["a tag", `    // <${BANNED_CALL} /> no-search-list: allowed`],
    [
      "a closing tag",
      `    // </p>; void ${BANNED_CALL}(); // no-search-list: allowed`,
    ],
  ])(
    "fails on a marked line comment with %s in the text of JSX",
    (_what, line) => {
      const root = tree(`marked-jsx-${_what.replaceAll(" ", "-")}`, {
        ...CLEAN,
        "apps/a/src/view.tsx": [
          "export const View = () => (",
          "  <div>",
          line,
          "  </div>",
          ");",
          "",
        ].join("\n"),
      });

      const result = gate(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("apps/a/src/view.tsx:3");
    },
  );

  it("scans the gate itself as any other file", () => {
    const root = tree("self", {
      ...CLEAN,
      "scripts/check-no-search-list.mjs": `const banned = "${BANNED_CALL}";\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/check-no-search-list.mjs:1");
  });

  it("passes a clean tree and counts the files it scanned", () => {
    const result = gate(tree("clean", CLEAN));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it("passes the repository with a count above zero", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });

    expect(result.status).toBe(0);
    expect(
      Number(/clean \((\d+) files\)/.exec(result.stdout)?.[1]),
    ).toBeGreaterThan(0);
  });

  it("does not scan a file git ignores", () => {
    const root = tree("ignored", {
      ...CLEAN,
      ".gitignore": "generated/\n",
      "apps/a/generated/client.ts": `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it("refuses a tree without a single source file", () => {
    const root = tree("empty", {
      "apps/README.md": "",
      "packages/.keep": "",
      "scripts/.keep": "",
      "test/.keep": "",
    });

    const result = gate(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "no source file under apps, packages, scripts, test",
    );
  });

  it("refuses a tree where a scanned directory is a file", () => {
    const root = tree("enotdir", {
      apps: "not a directory\n",
      "packages/b/src/index.ts": "export const b = 2;\n",
      "scripts/c.mjs": "",
      "test/d.test.ts": "",
    });

    const result = gate(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no source file under apps of");
  });

  it.each(["apps", "packages", "scripts", "test"])(
    "refuses a tree without the scanned directory %s",
    (missing) => {
      const contents = Object.fromEntries(
        Object.entries(CLEAN).filter(
          ([path]) => !path.startsWith(`${missing}/`),
        ),
      );
      const root = tree(`no-${missing}`, contents);

      const result = gate(root);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`no source file under ${missing} of`);
    },
  );

  it("refuses a tree git cannot list: no work tree", () => {
    const root = files("no-git", CLEAN);

    const result = gate(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${root}`);
    expect(result.stderr).toMatch(/not a git repository/i);
  });

  it("refuses a tree when git cannot be started", () => {
    const root = tree("no-git-binary", CLEAN);
    const env = Object.fromEntries(
      Object.entries(fixture.env).filter(
        ([key]) => key.toUpperCase() !== "PATH",
      ),
    );

    const result = gate(root, [], { ...env, PATH: "" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${root}`);
    expect(result.stderr).toContain("ENOENT");
  });

  it("refuses a file that readFileSync cannot read", () => {
    const root = tree("eacces", CLEAN);
    const file = join("packages", "b", "src", "index.ts");

    const result = gate(root, failing("eacces", "EACCES", file));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${join(root, file)}`);
    expect(result.stderr).toContain("EACCES");
  });

  it("names the root, not git, when the spawn of git throws with a path of its own", () => {
    // An error of node carries its argument as `path` - for a spawn, the
    // command: the gate must not take it for the file it could not read.
    const root = tree("spawn-throws", CLEAN);

    const result = gate(
      root,
      failing("spawn-throws", "EPERM", "git", { call: "spawnSync" }),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`no-search-list: cannot scan ${root}: `);
    expect(result.stderr).not.toContain("cannot scan git");
  });

  it("skips a file that is gone before readFileSync", () => {
    // A second source keeps test/ from being empty once the first is gone.
    const root = tree("gone", { ...CLEAN, "test/e.test.ts": "" });

    const result = gate(
      root,
      failing("gone", "ENOENT", join("test", "d.test.ts")),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it("refuses a tree whose only source of a directory is gone when it is read", () => {
    const root = tree("gone-only", CLEAN);

    const result = gate(
      root,
      failing("gone-only", "ENOENT", join("test", "d.test.ts")),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no source file under test of");
  });

  it("refuses a tree whose every listed file was gone when it was read", () => {
    const root = tree("all-gone", {
      "apps/a/src/index.ts": "",
      "packages/b/src/index.ts": "",
      "scripts/c.ts": "",
      "test/d.test.ts": "",
    });

    const result = gate(root, failing("all-gone", "ENOENT", ".ts"));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "no source file under apps, packages, scripts, test",
    );
  });

  it("skips a directory where git lists a file, and scans the rest", () => {
    const root = tree("directory-in-place", {
      ...CLEAN,
      "packages/b/src/x.ts": "",
    });
    fixture.git(root, ["add", "."]);
    rmSync(join(root, "packages", "b", "src", "x.ts"));
    mkdirSync(join(root, "packages", "b", "src", "x.ts"));

    const result = gate(root);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it("reads each listed source once, with no stat before: an EPERM of stat alone does not fail it", () => {
    // A stat-then-read gate refuses here; a single read sees the file.
    const root = tree("stat-eperm", CLEAN);
    const file = join("test", "d.test.ts");

    const result = gate(
      root,
      failing("stat-eperm", "EPERM", file, { call: "statSync" }),
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it.each(["EPERM", "EBUSY"])(
    "refuses what readFileSync cannot read on Windows (%s), even when it is gone after",
    (code) => {
      const name = `deleted-${code}`;
      const root = tree(name, CLEAN);
      const path = join("test", "d.test.ts");

      const result = gate(
        root,
        failing(name, code, path, { remove: true, platform: "win32" }),
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`cannot scan ${join(root, path)}`);
    },
  );

  it.each([
    ["a file still there on Windows", { platform: "win32" }],
    ["a file gone on another platform", { remove: true, platform: "linux" }],
  ] as const)("refuses EPERM on %s", (what, injected) => {
    const name = `eperm-${what.replaceAll(" ", "-")}`;
    const root = tree(name, CLEAN);
    const file = join("test", "d.test.ts");

    const result = gate(root, failing(name, "EPERM", file, injected));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${join(root, file)}`);
  });

  it("never reads a bundle of a vite config, which git ignores", () => {
    // How the bundle looks while vite deletes it on Windows: EPERM, never
    // ENOENT. It is not listed, so it is not read.
    const bundle = join(
      "apps",
      "a",
      "vitest.config.ts.timestamp-1729000000000-5a3c9d2e1f.mjs",
    );
    const root = tree("vite-bundle", {
      ...CLEAN,
      ".gitignore": "*.timestamp-*.mjs\n",
      [bundle]: `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(
      root,
      failing("vite-bundle", "EPERM", bundle, {
        remove: true,
        platform: "win32",
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });
});

/** The line terminators of JavaScript a split at LF leaves inside a line. */
const LONE_CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const MARK = "no-search-list: allowed";
/** The search resource and the endpoint, put together as the call is. */
const SEARCH = ["youtube", "search"].join(".");
const ENDPOINT = ["", "youtube", "v3", "search"].join("/");

describe("the rule of scripts/lib/search-list.mjs", () => {
  it.each([
    ["the call", `await ${BANNED_CALL}({});`],
    ["the call with a space before the brackets", `await ${SEARCH} ({});`],
    ["the search resource called", `await ${SEARCH}({});`],
    [
      "the method by its resource",
      `const list = ${["search", "list"].join(".")};`,
    ],
    ["the endpoint", `const url = "https://www.googleapis.com${ENDPOINT}";`],
  ])("breaks on %s", (_what, line) => {
    expect(breaksRule(line)).toBe(true);
  });

  it.each([
    ["another resource", "await youtube.videos.list({});"],
    ["a name that starts as the resource", "await youtube.searchTerms({});"],
    ["the mark alone", `export const y = 1; // ${MARK}`],
  ])("does not break on %s", (_what, line) => {
    expect(breaksRule(line)).toBe(false);
  });

  it.each([
    ["at the head of the line", `// never ${BANNED_CALL} - ${MARK}`],
    ["indented", `    // never ${BANNED_CALL} - ${MARK}`],
    [
      "before the CR of a CRLF line end",
      `// never ${BANNED_CALL} - ${MARK}${LONE_CR}`,
    ],
  ])("lets through a marked line comment %s", (_what, line) => {
    expect(breaksRule(line)).toBe(false);
  });

  // Each line is code, or may be code after what the lines above left
  // open: a block comment, a template, a string, the text of JSX.
  it.each([
    ["after the call", `await ${BANNED_CALL}({}); // ${MARK}`],
    ["in a string", `const why = "// ${MARK}"; await ${BANNED_CALL}({});`],
    [
      "after a closed block comment",
      `/* x */ await ${BANNED_CALL}({}); // ${MARK}`,
    ],
    [
      "after the end of a block comment",
      ` * x */ await ${BANNED_CALL}({}); // ${MARK}`,
    ],
    [
      "after the end of a block comment at the head",
      `*/ await ${BANNED_CALL}({}); // ${MARK}`,
    ],
    [
      "after one star that opens and closes",
      `/*/ ${BANNED_CALL}({}) // ${MARK}`,
    ],
    [
      "on a line going on with a product",
      `  * (await ${BANNED_CALL}({})).data; // ${MARK}`,
    ],
    ["on a line of a block comment", ` * never ${BANNED_CALL} (${MARK})`],
    [
      "on a line opening a block comment",
      `/** never ${BANNED_CALL} - ${MARK} */`,
    ],
    [
      "in a line comment closing a block comment",
      `// x */ ${BANNED_CALL}(); ${MARK}`,
    ],
    [
      "in a line comment closing a template",
      `// \` + ${BANNED_CALL}() + \` ${MARK}`,
    ],
    [
      "in a line comment opening a substitution",
      `// \${${BANNED_CALL}({})} ${MARK}`,
    ],
    [
      "in a line comment opening an expression of JSX",
      `// {${BANNED_CALL}({})} ${MARK}`,
    ],
    ["in a line comment opening a tag of JSX", `// <${BANNED_CALL} /> ${MARK}`],
    [
      "in a line comment closing a tag of JSX",
      `// </p>; void ${BANNED_CALL}(); // ${MARK}`,
    ],
    [
      "in a line comment closing a string",
      `// " + ${BANNED_CALL}() + " ${MARK}`,
    ],
    [
      "in a line comment closing a single-quoted string",
      `// ' + ${BANNED_CALL}() + ' ${MARK}`,
    ],
    ["before a lone CR", `// ${MARK}${LONE_CR}await ${BANNED_CALL}();`],
    [
      "before a line separator",
      `// ${MARK}${LINE_SEPARATOR}await ${BANNED_CALL}();`,
    ],
    [
      "before a paragraph separator",
      `// ${MARK}${PARAGRAPH_SEPARATOR}await ${BANNED_CALL}();`,
    ],
  ])("breaks on the mark %s", (_what, line) => {
    expect(breaksRule(line)).toBe(true);
  });

  it.each(SOURCE_EXTENSIONS)("takes a %s file for a source", (extension) => {
    expect(isSource(`apps/a/src/x${extension}`)).toBe(true);
  });

  it.each([
    "docs/sync.md",
    "packages/b/config.json",
    "infra/sync.sh",
    "apps/a/.ts",
    "apps/a.ts/README",
  ])("does not take %s for a source", (path) => {
    expect(isSource(path)).toBe(false);
  });
});
