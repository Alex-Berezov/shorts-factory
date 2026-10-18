import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { repoRoot, rootOf } from "../scripts/lib/paths.mjs";

describe("rootOf", () => {
  it.each(["checkout", "a b", "ж", join("a b", "ж")])(
    "finds the root of a checkout under a path %s",
    (folder) => {
      const root = join(tmpdir(), folder);
      const module = pathToFileURL(join(root, "scripts", "lib", "paths.mjs"));

      expect(rootOf(module.href, 2)).toBe(root);
    },
  );

  it("stays in the module's directory for zero levels", () => {
    const module = pathToFileURL(join(tmpdir(), "a b", "x.mjs"));

    expect(rootOf(module.href, 0)).toBe(join(tmpdir(), "a b"));
  });
});

describe("repoRoot", () => {
  it("is the directory of the workspace manifest", () => {
    expect(existsSync(join(repoRoot, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(repoRoot, "scripts", "lib", "paths.mjs"))).toBe(
      true,
    );
  });
});
