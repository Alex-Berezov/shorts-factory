import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ROOT } from "./dockerfile.js";

/**
 * The container healthcheck is a process of its own, started every 30 s with
 * five seconds to answer: every module it loads comes out of those seconds.
 * It needs a Redis client and a deadline; bullmq and pino are what the root
 * of `@sf/runtime` loads on top of them, and neither is of any use to it.
 *
 * The graph is read from the sources rather than from a running process, so
 * the case says which import pulled the module in. Every file it reads
 * belongs to this app or to a workspace dependency of it, whose own `test`
 * this task depends on in turbo (`^test`), so a change there is a change of
 * this hash too.
 */

const ENTRY_POINTS = [
  "apps/worker/src/cli/healthcheck.ts",
  "apps/worker/src/cli/healthcheck-run.ts",
];

/** Modules the healthcheck must not load. */
const HEAVY = ["bullmq", "pino"];

const ManifestSchema = z.object({
  exports: z.record(z.union([z.string(), z.record(z.string())])).optional(),
  main: z.string().optional(),
});

/**
 * The specifiers a module loads when it runs: `import`/`export ... from`
 * whose bindings are not all types. A type-only import is erased by the
 * compiler and loads nothing.
 */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const statement =
    /^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/gms;
  for (const match of source.matchAll(statement)) {
    const [, typeOnly, bindings = "", specifier] = match;
    if (typeOnly !== undefined || specifier === undefined) {
      continue;
    }
    const braced = /^\{([^}]*)\}$/.exec(bindings.trim());
    const names = braced?.[1]
      ?.split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names?.every((name) => name.startsWith("type "))) {
      continue;
    }
    found.push(specifier);
  }
  for (const match of source.matchAll(/^import\s+["']([^"']+)["']/gm)) {
    if (match[1] !== undefined) {
      found.push(match[1]);
    }
  }
  return found;
}

/** The file a `@sf/<package>[/<subpath>]` specifier resolves to under node. */
function workspaceFile(specifier: string): string {
  const [, name = "", subpath] =
    /^@sf\/([^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
  const packageDir = join(ROOT, "packages", name);
  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")),
  );
  const key = subpath === undefined ? "." : `./${subpath}`;
  const target =
    manifest.exports?.[key] ?? (key === "." ? manifest.main : undefined);
  const file = typeof target === "string" ? target : target?.default;
  if (file === undefined) {
    throw new Error(`${specifier} is not exported by @sf/${name}`);
  }
  return join(packageDir, file);
}

/** Every bare module the entry points load, with the file that loads it. */
function externalModules(entries: readonly string[]): Map<string, string> {
  const external = new Map<string, string>();
  const visited = new Set<string>();
  const queue = entries.map((entry) => join(ROOT, entry));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of valueImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else if (specifier.startsWith("@sf/")) {
        queue.push(workspaceFile(specifier));
      } else if (!external.has(specifier)) {
        external.set(specifier, file);
      }
    }
  }
  return external;
}

describe("the container healthcheck", () => {
  it("loads neither bullmq nor pino", () => {
    const loaded = externalModules(ENTRY_POINTS);

    // The walk did reach the client: a graph that lost its way is not a
    // graph without bullmq.
    expect([...loaded.keys()]).toContain("ioredis");
    for (const heavy of HEAVY) {
      expect({ module: heavy, loadedBy: loaded.get(heavy) }).toEqual({
        module: heavy,
        loadedBy: undefined,
      });
    }
  });

  it("would see bullmq through the root of @sf/runtime", () => {
    // The control of the case above: the same walk from the root of the
    // package finds the queue factory, so its absence there is the subpaths'
    // doing and not a walk that cannot see it.
    const loaded = externalModules([
      "apps/worker/src/cli/healthcheck.ts",
      "packages/runtime/src/index.ts",
    ]);

    expect(loaded.get("bullmq")).toMatch(/queues\.ts$/);
  });
});
