import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repoRoot } from "../src/paths.js";

const packageDir = join(repoRoot, "packages", "config");

/** Only the part of the manifest these tests are about. */
const ManifestSchema = z.object({
  exports: z.object({
    ".": z.record(z.string()),
    "./server": z.string(),
  }),
});

function readRootEntry(): Record<string, string> {
  const raw: unknown = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  return ManifestSchema.parse(raw).exports["."];
}

function readSource(target: string): string {
  return readFileSync(join(packageDir, target), "utf8");
}

describe("package exports", () => {
  it("sends browser bundlers of the root entry to the server-only module", () => {
    // A client component that imports `@sf/config` resolves to the module with
    // the marker, so Next fails the build instead of shipping config to the
    // browser - docs/adr/0001-config-server-entry.md.
    expect(readRootEntry().browser).toBe("./src/server.ts");
  });

  it("keeps `default` last so node, tsx and tsc get the plain module", () => {
    const rootEntry = readRootEntry();

    // Conditions are matched in declaration order and `default` matches
    // everything: anything after it would be dead.
    expect(Object.keys(rootEntry)).toEqual(["browser", "default"]);
    expect(rootEntry.default).toBe("./src/index.ts");
  });

  it("puts the marker in the browser target and never in the default one", () => {
    const rootEntry = readRootEntry();
    const browserTarget = rootEntry.browser;
    const defaultTarget = rootEntry.default;
    if (browserTarget === undefined || defaultTarget === undefined) {
      throw new Error("the root entry declares no browser/default condition");
    }

    expect(readSource(browserTarget)).toContain('import "server-only";');
    // `server-only` throws under every resolve condition except `react-server`,
    // so the marker in the default target would take down api, worker and db.
    expect(readSource(defaultTarget)).not.toContain('import "server-only";');
  });

  it("keeps the explicit `./server` subpath next to the conditional root", () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );

    expect(ManifestSchema.parse(raw).exports["./server"]).toBe(
      "./src/server.ts",
    );
  });
});
