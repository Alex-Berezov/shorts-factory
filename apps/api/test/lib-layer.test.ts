import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_SPECIFIER,
  importSpecifiers,
  sourceFiles,
} from "./source-ast.js";

/**
 * The layer of `src/lib`: `app.ts` imports it, and so do the modules of
 * `src/routes` and `src/plugins` that `app.ts` registers, so a file of
 * `src/lib` importing any of them back is a cycle that type-checks and loads
 * in silence (`AppInstance` lives in `lib/app-instance.ts` for that,
 * docs/adr/0015-route-registrar.md). Held by what the layer may import rather
 * than by a list of what it may not: a relative import stays inside
 * `src/lib` or names `src/deps` - the types of the ports (`HealthProbes`,
 * `BudgetProbe`, ...), which import nothing of the app - and a package
 * (`@sf/*`, `zod`) is not a file of the app. Read from the syntax tree of
 * every file at any depth (`source-ast.ts`), not with a pattern over the
 * text: an `export … from`, an import across lines and a file in a directory
 * of its own are imports all the same.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const LIB = join(SRC, "lib");

/** The one module outside `src/lib` the layer may import, without extension. */
const DEPS = join(SRC, "deps");

/**
 * The imports of the file `file` with the text `text` that leave the layer,
 * by their path from `src/` without extension; a specifier the walk cannot
 * read counts too, as `DYNAMIC_SPECIFIER` - what it loads cannot be told
 * apart from them.
 */
function importsOutOfLayer(file: string, text: string): string[] {
  return importSpecifiers(file, text).flatMap((specifier) => {
    if (specifier === DYNAMIC_SPECIFIER) return [specifier];
    if (!specifier.startsWith(".")) return [];
    const target = resolve(dirname(file), specifier).replace(
      /\.[cm]?[jt]sx?$/,
      "",
    );
    // Inside the directory of the layer, by its path and a separator: a
    // sibling whose name only starts like it (`lib-other`) is outside.
    const inLayer = target.startsWith(`${LIB}${sep}`);
    return inLayer || target === DEPS
      ? []
      : [relative(SRC, target).replaceAll("\\", "/")];
  });
}

describe("the layer of src/lib", () => {
  it("imports nothing of the app outside it but the ports of src/deps", () => {
    const files = sourceFiles(LIB);
    // The walk did reach the helper of the routes: a walk that found nothing
    // would find no import either.
    expect(files.map((file) => relative(LIB, file))).toContain(
      "define-route.ts",
    );
    const offending = files.flatMap((file) =>
      importsOutOfLayer(file, readFileSync(file, "utf8")).map(
        (module) => `${relative(SRC, file)}: ${module}`,
      ),
    );
    expect(offending).toEqual([]);
  });
});

describe("the reading of an import out of the layer", () => {
  const file = join(LIB, "x.ts");

  // The modules are named by the cases, not the specifiers: the texts
  // below are what is read, not paths this file reads.
  it.each([
    ["a static import", 'import { buildApp } from "../app.js";', "app"],
    [
      "a type-only import",
      'import type { BuildAppOptions } from "../app.js";',
      "app",
    ],
    [
      "an import across lines",
      'import {\n  buildApp,\n} from\n  "../app.js";',
      "app",
    ],
    ["a re-export", 'export { buildApp } from "../app.js";', "app"],
    ["a bare import", 'import "../server.js";', "server"],
    [
      "a lazy import",
      'const m = await import("../compose-app.js");',
      "compose-app",
    ],
    ["a require", 'const m = require("../app");', "app"],
    [
      "an import in a type",
      'type A = typeof import("../app.js").buildApp;',
      "app",
    ],
    [
      "an import of the routes",
      'import { registerRoutes } from "../routes/index.js";',
      "routes/index",
    ],
    [
      "an import of a plugin",
      'import { registerX } from "../plugins/x.js";',
      "plugins/x",
    ],
    [
      "an import of a module",
      'import { y } from "../modules/y/index.js";',
      "modules/y/index",
    ],
    [
      "a name that only starts like the layer",
      'import { y } from "../lib-other/y.js";',
      "lib-other/y",
    ],
    [
      "a lazy import it cannot read",
      "const m = await import(name);",
      DYNAMIC_SPECIFIER,
    ],
  ])("refuses %s", (_form, text, module) => {
    expect(importsOutOfLayer(file, text)).toEqual([module]);
  });

  it("resolves the import of a file in a directory of its own", () => {
    const nested = join(LIB, "x", "y.ts");
    expect(importsOutOfLayer(nested, 'import "../../app.js";')).toEqual([
      "app",
    ]);
    // The same text one level up names a module of the layer.
    expect(importsOutOfLayer(nested, 'import "../app.js";')).toEqual([]);
  });

  it("lets through the ports of src/deps, the layer itself, a package, a comment and a string", () => {
    const text = [
      '// import { buildApp } from "../app.js";',
      '/* export * from "../server.js"; */',
      'const hint = "import(\\"../app.js\\")";',
      'import type { HealthProbes } from "../deps.js";',
      'import { routeRegistrar } from "./define-route.js";',
      'import { x } from "./x.js";',
      'import { y } from "./nested/y.js";',
      'import { ErrorBodySchema } from "@sf/contracts";',
      'import { z } from "zod";',
    ].join("\n");
    expect(importsOutOfLayer(file, text)).toEqual([]);
  });
});

describe("sourceFiles", () => {
  it("lists the source files of TypeScript at any depth, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-source-files-"));
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      for (const name of [
        "top.ts",
        "a/mid.ts",
        "a/b/deep.ts",
        "a/esm.mts",
        "a/cjs.cts",
        "a/view.tsx",
        "a/note.md",
        "a/built.js",
        "a/ts.txt",
      ]) {
        writeFileSync(join(root, name), "");
      }
      expect(
        sourceFiles(root).map((file) =>
          relative(root, file).replaceAll("\\", "/"),
        ),
      ).toEqual([
        "a/b/deep.ts",
        "a/cjs.cts",
        "a/esm.mts",
        "a/mid.ts",
        "a/view.tsx",
        "top.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
