import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { repoRoot } from "@sf/config/paths";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The container healthcheck is a process of its own, started every 30 s with
 * five seconds to answer: every module it loads comes out of those seconds.
 * It needs a Redis client and a deadline; bullmq and pino are what the root
 * of `@sf/runtime` loads on top of them, and neither is of any use to it.
 *
 * The graph is read from the sources rather than from a running process, so
 * the case says which import pulled the module in. Every file it reads
 * belongs to this app or to a workspace package that is in `dependencies` of
 * this app and has a `test` script: this task depends on its `test` in turbo
 * (`^test`), so a change there is a change of this hash too. The walk throws
 * on any other package - the inputs of this task (`apps/worker/turbo.json`)
 * do not cover it, and a change there would replay a green run.
 */

const ENTRY_POINTS = [
  "apps/worker/src/cli/healthcheck.ts",
  "apps/worker/src/cli/healthcheck-run.ts",
];

/** Modules the healthcheck must not load. */
const HEAVY = ["bullmq", "pino"];

const ManifestSchema = z.object({
  name: z.string(),
  exports: z.record(z.union([z.string(), z.record(z.string())])).optional(),
  main: z.string().optional(),
  scripts: z.record(z.string()).optional(),
  dependencies: z.record(z.string()).optional(),
});
type Manifest = z.infer<typeof ManifestSchema>;

function manifestAt(dir: string): Manifest {
  return ManifestSchema.parse(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
  );
}

/** The workspace dependencies of this app, by their names. */
const DEPENDENCIES: ReadonlySet<string> = new Set(
  Object.keys(manifestAt(join(repoRoot, "apps/worker")).dependencies ?? {}),
);

function notHashed(name: string): Error {
  return new Error(
    `${name} is not a dependency of @sf/worker with a test script: its files are not in the hash of @sf/worker#test`,
  );
}

/**
 * Throws unless the package `name` with `manifest` is in the hash of this
 * task: one of `dependencies` with a `test` script of its own - and unless
 * `manifest` is the one of `name`: the link of `name` in the node_modules of
 * this app is where the walk looks, and a package renamed there would be
 * read for another.
 */
function assertHashed(
  name: string,
  manifest: Manifest,
  dependencies: ReadonlySet<string>,
): void {
  if (!dependencies.has(name)) {
    throw notHashed(name);
  }
  if (manifest.name !== name) {
    throw new Error(
      `the manifest read for ${name} is the one of ${manifest.name}`,
    );
  }
  if (manifest.scripts?.test === undefined) {
    throw notHashed(name);
  }
}

/**
 * The directory of the workspace package `name`, where node finds it from
 * this app: its link in `apps/worker/node_modules/@sf` (`packages/<name>`,
 * `packages/integrations/<name>`, ...). A package outside `dependencies` is
 * refused before its link is looked up, so it fails with the reason, not with
 * a missing link.
 */
function packageDirOf(name: string, dependencies: ReadonlySet<string>): string {
  if (!dependencies.has(name)) {
    throw notHashed(name);
  }
  return realpathSync(
    join(repoRoot, "apps/worker/node_modules", ...name.split("/")),
  );
}

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

/**
 * The file a `@sf/<package>[/<subpath>]` specifier resolves to under node;
 * throws on a package outside `dependencies` (`assertHashed`).
 */
function workspaceFile(
  specifier: string,
  dependencies: ReadonlySet<string>,
): string {
  const [, name = "", subpath] =
    /^@sf\/([^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
  const packageDir = packageDirOf(`@sf/${name}`, dependencies);
  const manifest = manifestAt(packageDir);
  assertHashed(`@sf/${name}`, manifest, dependencies);
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
function externalModules(
  entries: readonly string[],
  dependencies: ReadonlySet<string> = DEPENDENCIES,
): Map<string, string> {
  const external = new Map<string, string>();
  const visited = new Set<string>();
  const queue = entries.map((entry) => join(repoRoot, entry));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of valueImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else if (specifier.startsWith("@sf/")) {
        queue.push(workspaceFile(specifier, dependencies));
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

describe("the walk of the healthcheck graph", () => {
  it("refuses a package outside the dependencies of the worker", () => {
    const without = new Set(
      [...DEPENDENCIES].filter((n) => n !== "@sf/runtime"),
    );

    expect(() => externalModules(ENTRY_POINTS, without)).toThrow(
      "@sf/runtime is not a dependency of @sf/worker",
    );
  });

  it("finds a package where node does, under packages/integrations too", () => {
    expect(
      relative(repoRoot, packageDirOf("@sf/youtube", DEPENDENCIES)).replaceAll(
        "\\",
        "/",
      ),
    ).toBe("packages/integrations/youtube");
  });

  it("refuses a package outside the dependencies before its link", () => {
    expect(() => packageDirOf("@sf/web", DEPENDENCIES)).toThrow(
      "@sf/web is not a dependency of @sf/worker",
    );
  });

  it("refuses a dependency without a test script", () => {
    expect(() =>
      assertHashed(
        "@sf/runtime",
        { name: "@sf/runtime", scripts: {} },
        DEPENDENCIES,
      ),
    ).toThrow(
      "@sf/runtime is not a dependency of @sf/worker with a test script",
    );
  });

  it("refuses a manifest that is not of the package it was read for", () => {
    expect(() =>
      assertHashed(
        "@sf/runtime",
        { name: "@sf/db", scripts: { test: "vitest run" } },
        DEPENDENCIES,
      ),
    ).toThrow("the manifest read for @sf/runtime is the one of @sf/db");
  });
});
