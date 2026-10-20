import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseManifest,
  workspaceDirs,
  workspaceGlobs,
} from "../scripts/lib/manifest.mjs";

/**
 * The one reading of package manifests and of the workspace for the root
 * scripts and the root tests (`scripts/lib/manifest.mjs`): the shape of a
 * `package.json` a script reads, and the package directories of
 * `pnpm-workspace.yaml`.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-manifest-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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
  it("lists the directories of each glob that hold a package.json, sorted", () => {
    const root = join(scratch, "repo");
    const files: Record<string, string> = {
      "pnpm-workspace.yaml":
        "packages:\n  - packages/*\n  - apps/*\nonlyBuiltDependencies:\n  - esbuild\n",
      "apps/web/package.json": "{}",
      "apps/api/package.json": "{}",
      "packages/db/package.json": "{}",
      "packages/notes/readme.md": "",
      "esbuild/package.json": "{}",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }

    expect(workspaceDirs(root)).toEqual([
      "apps/api",
      "apps/web",
      "packages/db",
    ]);
  });
});
