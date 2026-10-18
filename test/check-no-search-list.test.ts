import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";

/**
 * The gate against the 100-unit YouTube search call, run as CI and the gate
 * hook run it - a child process - on trees made for each case. A gate that
 * could not read what it was to scan must say so (exit 2), not pass: a
 * missing or unreadable directory used to be skipped and the gate printed
 * "clean" over nothing. A failure of `statSync` or `readFileSync` on one file
 * is made by a module preloaded into the child (`--import`), which replaces
 * the function of `node:fs` for that one file - and, for the error a file
 * being deleted gives on Windows, removes it first and makes the child see
 * `win32` as its platform. Only `ENOENT` is a path gone; the bundles vite
 * writes next to a config are skipped by their name, not by their error.
 */
const SCRIPT = join(repoRoot, "scripts", "check-no-search-list.mjs");

/** The banned call, put together so this file does not carry it whole. */
const BANNED_CALL = ["youtube", "search", "list"].join(".");

const scratch = mkdtempSync(join(tmpdir(), "sf-no-search-list-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A tree under the scratch directory holding the given files (path -> contents). */
function tree(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

/** A run of the gate takes well under a second; a hung one is killed. */
const TIMEOUT_MS = 20_000;

function gate(root: string, preload: string[] = []) {
  return spawnSync(process.execPath, [...preload, SCRIPT, root], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
}

/** How the injected failure looks to the gate, beyond its code. */
interface Injected {
  /** The path is removed before the error is thrown, as a deleted file is. */
  remove?: boolean;
  /** `process.platform` the child sees. */
  platform?: NodeJS.Platform;
}

/**
 * Node flags that make `fs[call]` throw an error with `code` for the one file
 * whose path ends in `file`; everything else is read as it is.
 */
function failing(
  name: string,
  call: "statSync" | "readFileSync" | "readdirSync",
  code: string,
  file: string,
  { remove = false, platform }: Injected = {},
): string[] {
  const module = join(scratch, `${name}.preload.mjs`);
  writeFileSync(
    module,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      platform === undefined
        ? ""
        : `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
      `const real = fs.${call};`,
      // rmSync lists a directory through fs itself: no failure while it runs.
      "let removing = false;",
      `fs.${call} = (path, ...rest) => {`,
      `  if (!removing && String(path).endsWith(${JSON.stringify(file)})) {`,
      remove
        ? "    removing = true; fs.rmSync(path, { recursive: true, force: true }); removing = false;"
        : "",
      `    throw Object.assign(new Error(\`${code}: injected, \${path}\`), { code: ${JSON.stringify(code)} });`,
      "  }",
      "  return real(path, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return ["--import", pathToFileURL(module).href];
}

const CLEAN = {
  "apps/a/src/index.ts": "export const a = 1;\n",
  "packages/b/src/index.ts": "export const b = 2;\n",
  "scripts/c.mjs": "export const c = 3;\n",
  "test/d.test.ts": "export const d = 4;\n",
};

describe("check-no-search-list", () => {
  it("fails on the banned call and names the file and line", () => {
    const root = tree("hit", {
      ...CLEAN,
      "packages/b/src/sync.ts": `const x = 1;\nawait ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join("packages", "b", "src", "sync.ts:2"));
  });

  it("fails on the banned call in a test of the root project", () => {
    const root = tree("hit-test", {
      ...CLEAN,
      "test/x.test.ts": `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join("test", "x.test.ts:1"));
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

  it("refuses a tree without a single source file", () => {
    const root = tree("empty", {
      "apps/README.md": "",
      "packages/.keep": "",
      "scripts/.keep": "",
      "test/.keep": "",
    });

    const result = gate(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no source file");
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
    expect(result.stderr).toContain(`cannot scan ${join(root, "apps")}`);
    expect(result.stderr).toContain("ENOTDIR");
  });

  it.each(["apps", "packages", "scripts", "test"])(
    "refuses a tree without the scanned directory %s",
    (missing) => {
      const files = Object.fromEntries(
        Object.entries(CLEAN).filter(
          ([path]) => !path.startsWith(`${missing}/`),
        ),
      );
      const root = tree(`no-${missing}`, files);

      const result = gate(root);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`cannot scan ${join(root, missing)}`);
      expect(result.stderr).toContain("ENOENT");
    },
  );

  it.each(["statSync", "readFileSync"] as const)(
    "refuses a file that %s cannot read",
    (call) => {
      const root = tree(`eacces-${call}`, CLEAN);
      const file = join("packages", "b", "src", "index.ts");

      const result = gate(root, failing(call, call, "EACCES", file));

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`cannot scan ${join(root, file)}`);
      expect(result.stderr).toContain("EACCES");
    },
  );

  it.each([
    ["statSync", join("test", "d.test.ts")],
    ["readFileSync", join("test", "d.test.ts")],
    ["readdirSync", join("apps", "a", "src")],
  ] as const)(
    "skips what is gone before %s, as vite's bundles of a config are",
    (call, path) => {
      const root = tree(`gone-${call}`, CLEAN);

      const result = gate(root, failing(`gone-${call}`, call, "ENOENT", path));

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("no-search-list: clean (3 files)");
    },
  );
  it("refuses a nested directory that readdirSync cannot read", () => {
    const root = tree("eacces-readdirSync", CLEAN);
    const dir = join("apps", "a", "src");

    const result = gate(
      root,
      failing("eacces-readdirSync", "readdirSync", "EACCES", dir),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${join(root, dir)}`);
    expect(result.stderr).toContain("EACCES");
  });

  it.each([
    ["statSync", "EPERM", join("test", "d.test.ts")],
    ["readFileSync", "EPERM", join("test", "d.test.ts")],
    ["readFileSync", "EBUSY", join("test", "d.test.ts")],
    ["readdirSync", "EPERM", join("apps", "a", "src")],
  ] as const)(
    "refuses what %s cannot read on Windows (%s), even when it is gone after",
    (call, code, path) => {
      const name = `deleted-${call}-${code}`;
      const root = tree(name, CLEAN);

      const result = gate(
        root,
        failing(name, call, code, path, { remove: true, platform: "win32" }),
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`cannot scan ${join(root, path)}`);
    },
  );

  it("skips a bundle of a vite config by its name, and only that name", () => {
    const text = `await ${BANNED_CALL}({});
`;
    const bundle = join(
      "apps",
      "a",
      "vitest.config.ts.timestamp-1729000000000-5a3c9d2e1f.mjs",
    );
    const skipped = gate(tree("vite-bundle", { ...CLEAN, [bundle]: text }));
    const scanned = gate(
      tree("vite-bundle-other", { ...CLEAN, "apps/a/x.mjs": text }),
    );

    expect(skipped.status).toBe(0);
    expect(skipped.stdout.trim()).toBe("no-search-list: clean (4 files)");
    expect(scanned.status).toBe(1);
    expect(scanned.stderr).toContain(join("apps", "a", "x.mjs:1"));
  });

  it("walks a directory named as a bundle of a vite config", () => {
    const root = tree("vite-bundle-dir", {
      ...CLEAN,
      "apps/a/x.timestamp-1-ab.mjs/y.ts": `await ${BANNED_CALL}({});\n`,
    });

    const result = gate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      join("apps", "a", "x.timestamp-1-ab.mjs", "y.ts:1"),
    );
  });

  it("skips a bundle of a vite config that statSync cannot read on Windows", () => {
    // How the bundle looks while vite deletes it: EPERM, never ENOENT.
    const bundle = join(
      "apps",
      "a",
      "vitest.config.ts.timestamp-1729000000000-5a3c9d2e1f.mjs",
    );
    const root = tree("vite-bundle-eperm", { ...CLEAN, [bundle]: "" });

    const result = gate(
      root,
      failing("vite-bundle-eperm", "statSync", "EPERM", bundle, {
        remove: true,
        platform: "win32",
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("no-search-list: clean (4 files)");
  });

  it.each([
    ["a file still there on Windows", { platform: "win32" }],
    ["a file gone on another platform", { remove: true, platform: "linux" }],
  ] as const)("refuses EPERM on %s", (what, injected) => {
    const name = `eperm-${what.replaceAll(" ", "-")}`;
    const root = tree(name, CLEAN);
    const file = join("test", "d.test.ts");

    const result = gate(
      root,
      failing(name, "readFileSync", "EPERM", file, injected),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${join(root, file)}`);
  });

  it("refuses a scanned directory removed on Windows: it was not listed", () => {
    const root = tree("deleted-top", CLEAN);

    const result = gate(
      root,
      failing("deleted-top", "readdirSync", "EPERM", "scripts", {
        remove: true,
        platform: "win32",
      }),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot scan ${join(root, "scripts")}`);
  });
});
