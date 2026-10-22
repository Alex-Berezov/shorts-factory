import { describe, expect, it } from "vitest";
import {
  parseManifest,
  workspaceDirs,
  workspaceGlobs,
} from "../scripts/lib/manifest.mjs";
import { gitScratch } from "./git-fixture.js";
import {
  parseRepoYaml,
  readRepoYaml,
  repoWorkspaceDirs,
} from "./repo-files.js";

/**
 * The one reading of package manifests and of the workspace for the root
 * scripts and the root tests (`scripts/lib/manifest.mjs`): the shape of a
 * `package.json` a script reads, and the package directories of
 * `pnpm-workspace.yaml`.
 */
const scratch = gitScratch("sf-manifest-");

describe("parseManifest", () => {
  it.each([
    ["not an object", [], "not a JSON object"],
    ["a name that is not a string", { name: 1 }, '"name" is not a string'],
    [
      "dependencies that are not an object",
      { name: "a", dependencies: ["x"] },
      '"dependencies" is not an object of strings',
    ],
    [
      "a range that is not a string",
      { name: "a", dependencies: { x: 1 } },
      '"dependencies" is not an object of strings',
    ],
  ])("refuses %s, naming the field", (_, value, message) => {
    expect(() => parseManifest(value, "x/package.json")).toThrow(
      `x/package.json: ${message}`,
    );
  });

  it("gives a manifest without dependencies an empty table", () => {
    expect(parseManifest({ name: "a" }, "x")).toEqual({
      name: "a",
      dependencies: {},
    });
  });
});

describe("workspaceGlobs", () => {
  it("reads the list under packages: and no other key of the file", () => {
    const yaml = [
      "# the workspace",
      "packages:",
      '  - "apps/*"',
      "  - 'packages/*' # shared code",
      "",
      "  - packages/integrations/*",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "catalog:",
      "  zod: ^3.23.0",
      "catalogs:",
      "  next:",
      "    - x",
    ].join("\n");

    expect(workspaceGlobs(yaml)).toEqual([
      "apps/*",
      "packages/*",
      "packages/integrations/*",
    ]);
  });

  it("reads the list after another key, with items at column 0 and CRLF", () => {
    const yaml = [
      "onlyBuiltDependencies:",
      "  - esbuild",
      "packages:",
      "- apps/*",
      "- packages/*",
    ].join("\r\n");

    expect(workspaceGlobs(yaml)).toEqual(["apps/*", "packages/*"]);
  });

  it.each([
    [
      "no packages: key",
      "onlyBuiltDependencies:\n  - esbuild\n",
      "no block list under packages:",
    ],
    ["a flow list", 'packages: ["apps/*"]\n', "no block list under packages:"],
    [
      "an empty list",
      "packages:\ncatalog:\n  zod: ^3\n",
      "lists no package glob",
    ],
    [
      "a map under the key",
      "packages:\n  apps: x\n",
      '"apps: x" under packages: is not a list item',
    ],
    [
      "a glob of another form",
      "packages:\n  - apps/**\n",
      'workspace glob "apps/**" is not of the form dir/*',
    ],
    [
      "a negated glob",
      "packages:\n  - '!apps/x'\n",
      'workspace glob "!apps/x" is not of the form dir/*',
    ],
  ])("refuses %s", (_, yaml, message) => {
    expect(() => workspaceGlobs(yaml)).toThrow(message);
  });
});

describe("workspaceDirs", () => {
  const WORKSPACE: Record<string, string> = {
    "pnpm-workspace.yaml":
      "packages:\n  - packages/*\n  - packages/integrations/*\n  - apps/*\nonlyBuiltDependencies:\n  - esbuild\n",
    "apps/web/package.json": "{}",
    "apps/api/package.json": "{}",
    "packages/db/package.json": "{}",
    "packages/notes/readme.md": "",
    "packages/db/nested/package.json": "{}",
    "packages/integrations/youtube/package.json": "{}",
    "esbuild/package.json": "{}",
  };

  it("lists the directories of each glob that hold a package.json, sorted", () => {
    const root = scratch.files("repo", WORKSPACE);

    expect(workspaceDirs(root, Object.keys(WORKSPACE))).toEqual([
      "apps/api",
      "apps/web",
      "packages/db",
      "packages/integrations/youtube",
    ]);
  });

  it("takes the files from git by default: an ignored package.json is no package", () => {
    const root = scratch.tree("git-repo", {
      ...WORKSPACE,
      ".gitignore": "apps/old/\n",
      "apps/old/package.json": "{}",
    });

    expect(workspaceDirs(root)).toEqual([
      "apps/api",
      "apps/web",
      "packages/db",
      "packages/integrations/youtube",
    ]);
  });

  it.each([
    ["no file under its directory", "tools/*", {}],
    [
      "only an ignored or deeper package.json",
      "tools/*",
      { "tools/readme.md": "", "tools/a/b/package.json": "{}" },
    ],
  ])(
    "takes a glob that holds no package for none, as pnpm does: %s",
    (_what, glob, extra) => {
      const contents: Record<string, string> = {
        ...WORKSPACE,
        "pnpm-workspace.yaml": `packages:\n  - apps/*\n  - ${glob}\n`,
        ...extra,
      };
      const root = scratch.files(
        `empty-glob-${Object.keys(extra).length}`,
        contents,
      );

      expect(workspaceDirs(root, Object.keys(contents))).toEqual([
        "apps/api",
        "apps/web",
      ]);
    },
  );

  it("refuses a workspace whose globs together hold no package", () => {
    const contents: Record<string, string> = {
      ...WORKSPACE,
      "pnpm-workspace.yaml": "packages:\n  - tools/*\n  - lib/*\n",
      "tools/readme.md": "",
    };
    const root = scratch.files("no-package", contents);

    expect(() => workspaceDirs(root, Object.keys(contents))).toThrow(
      "pnpm-workspace.yaml holds no package",
    );
  });

  it("refuses a tree git cannot list", () => {
    // No `git init`, and git does not climb out of the scratch directory
    // (`test/git-fixture.ts`): it refuses to list the tree.
    const root = scratch.files("no-repo", WORKSPACE);
    expect(() => workspaceDirs(root)).toThrow(/git ls-files in .* failed/);
  });
});

/**
 * The package directories of a lockfile: the keys of its `importers`, read
 * from the value of `pnpm-lock.yaml` (`parseRepoYaml`, the fail-closed
 * `readYaml`), with `.` left out - the root project is an importer of every
 * lockfile, but no glob of `pnpm-workspace.yaml` names it and `workspaceDirs`
 * never lists it. A lockfile with no `importers`, or one that is not a table,
 * is refused rather than taken for an empty workspace.
 */
function importerDirs(lock: unknown): string[] {
  const importers =
    typeof lock === "object" && lock !== null
      ? Reflect.get(lock, "importers")
      : undefined;
  if (
    typeof importers !== "object" ||
    importers === null ||
    Array.isArray(importers)
  ) {
    throw new Error("pnpm-lock.yaml: importers is missing or not a table");
  }
  return Object.keys(importers)
    .filter((dir) => dir !== ".")
    .sort();
}

/**
 * Where the package directories of the workspace (`workspaceDirs`) and the
 * importers of the lockfile part, each by name: a package pnpm installs that
 * the listing misses drops out of the lock of directions and of probe-image
 * silently, and a directory the listing takes for a package that pnpm does
 * not know has no install behind it.
 */
function importerGap(
  dirs: readonly string[],
  importers: readonly string[],
): string[] {
  return [
    ...dirs
      .filter((dir) => !importers.includes(dir))
      .map(
        (dir) =>
          `${dir}: a package of the workspace, not an importer of pnpm-lock.yaml`,
      ),
    ...importers
      .filter((dir) => !dirs.includes(dir))
      .map(
        (dir) =>
          `${dir}: an importer of pnpm-lock.yaml, not a package of the workspace`,
      ),
  ];
}

describe("workspaceDirs against the importers of pnpm-lock.yaml", () => {
  const lock = (): unknown => readRepoYaml("pnpm-lock.yaml");

  it("lists exactly the importers of the lockfile, the root left out", () => {
    const dirs = repoWorkspaceDirs();

    expect(dirs.length).toBeGreaterThan(0);
    expect(importerGap(dirs, importerDirs(lock()))).toEqual([]);
  });

  it("names a directory the listing has and the lockfile does not", () => {
    const importers = importerDirs(lock());

    expect(
      importerGap([...repoWorkspaceDirs(), "packages/ghost"], importers),
    ).toEqual([
      "packages/ghost: a package of the workspace, not an importer of pnpm-lock.yaml",
    ]);
  });

  it("names an importer the listing misses", () => {
    const dirs = repoWorkspaceDirs();
    const [dropped, ...kept] = dirs;
    if (dropped === undefined) throw new Error("no package of the workspace");

    expect(importerGap(kept, importerDirs(lock()))).toEqual([
      `${dropped}: an importer of pnpm-lock.yaml, not a package of the workspace`,
    ]);
  });

  it.each<[string, unknown]>([
    ["no importers", { lockfileVersion: "9.0" }],
    ["importers that are a list", { importers: ["apps/api"] }],
    ["importers that are text", { importers: "apps/api" }],
    ["a lockfile that is not a table", "lockfileVersion: 9.0"],
  ])("refuses a lockfile with %s", (_what, broken) => {
    expect(() => importerDirs(broken)).toThrow(
      "pnpm-lock.yaml: importers is missing or not a table",
    );
  });

  it("refuses a lockfile it cannot read cleanly, through readYaml", () => {
    expect(() =>
      parseRepoYaml("importers:\n  .: {}\nimporters: {}\n", "pnpm-lock.yaml"),
    ).toThrow("pnpm-lock.yaml is not read cleanly");
  });
});
