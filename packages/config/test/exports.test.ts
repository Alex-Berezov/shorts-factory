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
    // Optional here, so a missing subpath fails its own test, not every one.
    "./server-secrets": z.string().optional(),
  }),
});

/** Every subpath with its target: a path, or conditions mapped to paths. */
const AllExportsSchema = z.object({
  exports: z.record(z.union([z.string(), z.record(z.string())])),
});

/**
 * Subpaths a browser bundle may resolve to their own file: the list of secret
 * names (no values; the client bundle check reads it) and the vitest setup.
 */
const BROWSER_SAFE_SUBPATHS = new Set(["./server-secrets", "./vitest/setup"]);

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

  it("sends browser bundlers of every code subpath to the server-only module", () => {
    // A subpath that reads the environment (`./redis-url` reads REDIS_URL and
    // the root .env) would otherwise put a server secret into a client chunk
    // without a failing build - the root entry's rule holds for each of them.
    const raw: unknown = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    const subpaths = Object.entries(AllExportsSchema.parse(raw).exports).filter(
      ([subpath]) => !BROWSER_SAFE_SUBPATHS.has(subpath),
    );

    expect(subpaths.map(([subpath]) => subpath)).toContain("./redis-url");
    for (const [subpath, target] of subpaths) {
      const browserTarget =
        typeof target === "string" ? target : target.browser;
      expect({ subpath, browserTarget }).toEqual({
        subpath,
        browserTarget: "./src/server.ts",
      });
      if (typeof target !== "string") {
        // `default` last, as for the root entry: conditions after it are dead.
        expect(Object.keys(target).at(-1)).toBe("default");
      }
    }
  });

  it("publishes the list of server secrets as its own subpath", () => {
    // The client bundle check of apps/web reads this list from plain node,
    // without a TypeScript loader, so it stays a JSON file.
    const raw: unknown = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );

    expect(ManifestSchema.parse(raw).exports["./server-secrets"]).toBe(
      "./src/server-secrets.json",
    );
  });
});
