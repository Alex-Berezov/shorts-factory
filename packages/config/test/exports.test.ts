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

/**
 * What is wrong with the order of a subpath's conditions, if anything.
 * Conditions are matched in declaration order: `browser` first, so no
 * condition a bundler also knows (`import`, `node`) wins before it, and
 * `default` last, because it matches everything and anything after it is dead.
 */
function conditionOrderIssue(
  conditions: Record<string, string>,
): string | undefined {
  const keys = Object.keys(conditions);
  if (keys[0] !== "browser") {
    return "`browser` is not the first condition";
  }
  if (keys.at(-1) !== "default") {
    return "`default` is not the last condition";
  }
  return undefined;
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
    // `./paths` resolves the repository root on the server: the test support
    // of the packages takes `.env.test` from it (ADR-0011, "Границы").
    expect(subpaths.map(([subpath]) => subpath)).toContain("./paths");
    for (const [subpath, target] of subpaths) {
      const browserTarget =
        typeof target === "string" ? target : target.browser;
      expect({ subpath, browserTarget }).toEqual({
        subpath,
        browserTarget: "./src/server.ts",
      });
      if (typeof target !== "string") {
        expect({ subpath, order: conditionOrderIssue(target) }).toEqual({
          subpath,
          order: undefined,
        });
      }
    }
  });

  it("names a subpath whose browser condition is not the first one", () => {
    // A bundler takes the first condition it knows: `import` ahead of
    // `browser` sends a client bundle to the plain module, secret and all.
    expect(
      conditionOrderIssue({
        import: "./src/redis-url.ts",
        browser: "./src/server.ts",
        default: "./src/redis-url.ts",
      }),
    ).toBe("`browser` is not the first condition");
  });

  it("names a subpath whose default condition is not the last one", () => {
    expect(
      conditionOrderIssue({
        browser: "./src/server.ts",
        default: "./src/redis-url.ts",
        node: "./src/redis-url.ts",
      }),
    ).toBe("`default` is not the last condition");
  });

  it("names nothing for browser first and default last", () => {
    expect(
      conditionOrderIssue({
        browser: "./src/server.ts",
        node: "./src/redis-url.ts",
        default: "./src/redis-url.ts",
      }),
    ).toBeUndefined();
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
