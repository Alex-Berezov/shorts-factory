import { describe, expect, it } from "vitest";
import {
  type SourceFile,
  type WorkspacePackage,
  importViolations,
  manifestViolations,
  readWorkspace,
  tableViolations,
} from "./dependency-direction.js";
import type { Manifest } from "./repo-files.js";
import { workspacePackageDirs } from "./repo-files.js";

/**
 * The direction of dependencies (docs/10_SYSTEM_DESIGN.md §6): every row of
 * the table and every branch of the check on a workspace made up for it, and
 * then the workspace itself.
 */

/** A package of a made-up workspace. */
function pkg(
  dir: string,
  name: string,
  manifest: Omit<Manifest, "name"> = {},
  files: SourceFile[] = [],
): WorkspacePackage {
  return { dir, manifest: { name, ...manifest }, files };
}

/** Every package of the table under its real name and directory, with no dependencies and no files. */
const PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ["apps/api", "@sf/api"],
  ["apps/web", "@sf/web"],
  ["apps/worker", "@sf/worker"],
  ["packages/core", "@sf/core"],
  ["packages/config", "@sf/config"],
  ["packages/contracts", "@sf/contracts"],
  ["packages/api-client", "@sf/api-client"],
  ["packages/db", "@sf/db"],
  ["packages/runtime", "@sf/runtime"],
  ["packages/integrations/youtube", "@sf/youtube"],
  ["packages/integrations/gemini", "@sf/gemini"],
  ["packages/integrations/tts", "@sf/tts"],
];

function baseWorkspace(): WorkspacePackage[] {
  return PACKAGES.map(([dir, name]) => pkg(dir, name));
}

/** The directory of a package of the table. */
function dirOf(name: string): string {
  const found = PACKAGES.find(([, known]) => known === name);
  if (found === undefined) throw new Error(`${name} is not in PACKAGES`);
  return found[0];
}

/** The base workspace with `replacement` in place of the package of the same directory. */
function withPackage(replacement: WorkspacePackage): WorkspacePackage[] {
  return baseWorkspace().map((existing) =>
    existing.dir === replacement.dir ? replacement : existing,
  );
}

const file = (path: string, text: string): SourceFile => ({ path, text });

/** Every edge the table allows, as the manifests have them today. */
const ALLOWED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["@sf/core", []],
  ["@sf/config", []],
  ["@sf/contracts", ["@sf/core"]],
  ["@sf/api-client", ["@sf/contracts"]],
  ["@sf/db", ["@sf/core", "@sf/config"]],
  ["@sf/runtime", ["@sf/config", "@sf/core"]],
  ["@sf/youtube", ["@sf/core", "@sf/config"]],
  ["@sf/gemini", ["@sf/core", "@sf/config"]],
  ["@sf/tts", ["@sf/core", "@sf/config"]],
  ["@sf/web", ["@sf/api-client", "@sf/contracts", "@sf/config"]],
  [
    "@sf/api",
    [
      "@sf/config",
      "@sf/contracts",
      "@sf/core",
      "@sf/db",
      "@sf/runtime",
      "@sf/youtube",
    ],
  ],
  [
    "@sf/worker",
    [
      "@sf/config",
      "@sf/core",
      "@sf/db",
      "@sf/runtime",
      "@sf/youtube",
      "@sf/gemini",
      "@sf/tts",
    ],
  ],
];

/** One edge against the direction per row of the table. */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["@sf/core", "@sf/contracts"],
  ["@sf/config", "@sf/core"],
  ["@sf/contracts", "@sf/config"],
  ["@sf/api-client", "@sf/core"],
  ["@sf/db", "@sf/runtime"],
  ["@sf/runtime", "@sf/db"],
  ["@sf/youtube", "@sf/db"],
  ["@sf/gemini", "@sf/runtime"],
  ["@sf/tts", "@sf/contracts"],
  ["@sf/web", "@sf/db"],
  ["@sf/web", "@sf/core"],
  ["@sf/web", "@sf/runtime"],
  ["@sf/web", "@sf/api"],
  ["@sf/api", "@sf/gemini"],
  ["@sf/api", "@sf/worker"],
  ["@sf/worker", "@sf/api-client"],
];

describe("tableViolations", () => {
  it("passes a workspace with a package for every row and every target", () => {
    expect(tableViolations(baseWorkspace())).toEqual([]);
  });

  it("refuses a row, and a target, the workspace does not have", () => {
    expect(
      tableViolations(
        baseWorkspace().filter((entry) => entry.manifest.name !== "@sf/tts"),
      ),
    ).toEqual([
      "the table has a row for @sf/tts, not in the workspace",
      "the row of @sf/worker allows @sf/tts, not in the workspace",
    ]);
  });
});

describe("manifestViolations", () => {
  it.each(ALLOWED)("passes every edge of the row of %s", (name, targets) => {
    const dependencies = Object.fromEntries(
      [...targets, "zod"].map((to) => [to, "workspace:*"]),
    );
    expect(
      manifestViolations(withPackage(pkg(dirOf(name), name, { dependencies }))),
    ).toEqual([]);
  });

  it.each(REFUSED)("refuses %s -> %s", (name, to) => {
    expect(
      manifestViolations(
        withPackage(
          pkg(dirOf(name), name, { dependencies: { [to]: "workspace:*" } }),
        ),
      ),
    ).toEqual([`${dirOf(name)}/package.json dependencies: ${to}`]);
  });

  it.each([
    ["devDependencies", "@sf/contracts", "@sf/config"],
    ["peerDependencies", "@sf/core", "@sf/contracts"],
    ["optionalDependencies", "@sf/db", "@sf/runtime"],
  ] as const)("refuses an edge outside the table in %s", (field, name, to) => {
    expect(
      manifestViolations(
        withPackage(
          pkg(dirOf(name), name, { [field]: { [to]: "workspace:*" } }),
        ),
      ),
    ).toEqual([`${dirOf(name)}/package.json ${field}: ${to}`]);
  });

  it("refuses an edge to a package that is not in the workspace", () => {
    expect(
      manifestViolations(
        withPackage(
          pkg("apps/api", "@sf/api", {
            dependencies: { "@sf/storage": "workspace:*" },
          }),
        ),
      ),
    ).toEqual(["apps/api/package.json dependencies: @sf/storage"]);
  });

  it.each([
    ["packages/storage", "@sf/storage"],
    ["apps/admin", "@sf/admin"],
  ])("refuses %s, a package the table does not know", (dir, name) => {
    expect(manifestViolations([...baseWorkspace(), pkg(dir, name)])).toEqual([
      `${name} (${dir}) is not in the table of allowed edges`,
    ]);
  });
});

describe("importViolations", () => {
  it("passes imports along the table, @sf/config in the files of ADR-0002 and comments", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/client.ts", 'import { AppError } from "@sf/core";'),
            file(
              "src/budget.ts",
              "/** Structurally the `Limits` of `@sf/config`. */\nexport const x = 1;",
            ),
            file("src/cli/migrate.ts", 'import { env } from "@sf/config";'),
            file("test/a.int.test.ts", 'import { env } from "@sf/config";'),
            file(
              "test-support/fixture.ts",
              'import { env } from "@sf/config";',
            ),
            file("vitest.int.config.ts", 'import "@sf/config/vitest/setup";'),
            file("vitest.config.mts", 'import "@sf/config/vitest/setup";'),
            file(
              "vitest.e2e.config.cts",
              'require("@sf/config/vitest/setup");',
            ),
            file(
              "drizzle.config.ts",
              "// through `@sf/config`, see ADR-0002\n",
            ),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it.each(REFUSED)("refuses an import %s -> %s", (name, to) => {
    expect(
      importViolations(
        withPackage(
          pkg(dirOf(name), name, {}, [
            file("src/x.ts", `import { x } from "${to}";`),
          ]),
        ),
      ),
    ).toEqual([`${dirOf(name)}/src/x.ts: ${to}`]);
  });

  it.each([
    ['const m = await import("@sf/config/server");', "@sf/config/server"],
    ['vi.mock("@sf/core");', "@sf/core"],
    ['const p = require.resolve("@sf/db");', "@sf/db"],
  ])("refuses every form the parser reads: %s", (text, specifier) => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/api-client", "@sf/api-client", {}, [
            file("test/x.test.ts", text),
          ]),
        ),
      ),
    ).toEqual([`packages/api-client/test/x.test.ts: ${specifier}`]);
  });

  it("passes web taking @sf/config/server in src and @sf/config outside src", () => {
    expect(
      importViolations(
        withPackage(
          pkg("apps/web", "@sf/web", {}, [
            file("src/lib/env.ts", 'import { env } from "@sf/config/server";'),
            file("next.config.ts", 'import { env } from "@sf/config";'),
            file(
              "scripts/client-bundle.mjs",
              'import { repoRoot } from "@sf/config/paths";',
            ),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it.each(["@sf/config", "@sf/config/redis-url", "@sf/config/paths"])(
    "refuses %s in the code of web",
    (specifier) => {
      expect(
        importViolations(
          withPackage(
            pkg("apps/web", "@sf/web", {}, [
              file("src/app/page.tsx", `import { x } from "${specifier}";`),
            ]),
          ),
        ),
      ).toEqual([
        `apps/web/src/app/page.tsx: ${specifier} (web code takes only @sf/config/server)`,
      ]);
    },
  );

  it("refuses @sf/config in @sf/db outside the files of ADR-0002", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/client.ts", 'import { env } from "@sf/config";'),
            file("drizzle.config.ts", 'import { env } from "@sf/config";'),
            file("vitest.config.js", 'import "@sf/config/vitest/setup";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/client.ts: @sf/config (ADR-0002: only the CLI, tests and vitest configs)",
      "packages/db/drizzle.config.ts: @sf/config (ADR-0002: only the CLI, tests and vitest configs)",
      "packages/db/vitest.config.js: @sf/config/vitest/setup (ADR-0002: only the CLI, tests and vitest configs)",
    ]);
  });

  it.each([
    "@sf/db/test-support/fixture",
    "@sf/runtime/test-support/recording-logger",
  ])(
    "refuses the test support %s from src, and passes it from tests",
    (specifier) => {
      expect(
        importViolations(
          withPackage(
            pkg("apps/worker", "@sf/worker", {}, [
              file("src/main.ts", `import { x } from "${specifier}";`),
              file("test/helpers.ts", `export { x } from "${specifier}";`),
            ]),
          ),
        ),
      ).toEqual([
        `apps/worker/src/main.ts: ${specifier} (test support from src)`,
      ]);
    },
  );

  it.each([
    ["packages/db", "@sf/db"],
    ["packages/runtime", "@sf/runtime"],
  ])(
    "refuses a relative path from src of %s into its own test support",
    (dir, name) => {
      expect(
        importViolations(
          withPackage(
            pkg(dir, name, {}, [
              file(
                "src/repos/x.ts",
                'import { y } from "../../test-support/fixture.js";',
              ),
              file("src/x.ts", 'import { a } from "./repos/a.js";'),
            ]),
          ),
        ),
      ).toEqual([
        `${dir}/src/repos/x.ts: ../../test-support/fixture.js (test support from src)`,
      ]);
    },
  );

  it.each([
    [
      "packages/db",
      "@sf/db",
      "src/x.ts",
      "../../config/src/index.js",
      "packages/config",
    ],
    [
      "apps/web",
      "@sf/web",
      "src/app/page.tsx",
      "../../../../packages/db/src/index.js",
      "packages/db",
    ],
    [
      "packages/contracts",
      "@sf/contracts",
      "test/x.test.ts",
      "../../core/src/index.js",
      "packages/core",
    ],
    [
      "apps/api",
      "@sf/api",
      "src/x.ts",
      "../../worker/src/index.js",
      "apps/worker",
    ],
  ])(
    "refuses a relative path from %s into another package, even one the table allows",
    (dir, name, path, specifier, into) => {
      expect(
        importViolations(
          withPackage(
            pkg(dir, name, {}, [file(path, `import "${specifier}";`)]),
          ),
        ),
      ).toEqual([
        `${dir}/${path}: ${specifier} (relative path into ${into}: a package is taken by its @sf/* name)`,
      ]);
    },
  );

  it("refuses a relative path out of the repository", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/x.ts", 'import "../../../../outside.js";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/x.ts: ../../../../outside.js (relative path out of the repository)",
    ]);
  });

  it("passes a relative path inside the package and to a root preset, and the package's own name", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/integrations/youtube", "@sf/youtube", {}, [
            file("src/x.ts", 'import { a } from "./a.js";'),
            file("src/repos/y.ts", 'import { b } from "../lib/b.js";'),
            file("test/z.test.ts", 'import { c } from "../src/x.js";'),
            file(
              "vitest.config.ts",
              'import { unitTestConfig } from "../../../vitest.preset.js";',
            ),
            file("test/self.test.ts", 'import { d } from "@sf/youtube/d";'),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("refuses an import it cannot read", () => {
    expect(
      importViolations(
        withPackage(
          pkg("apps/api", "@sf/api", {}, [
            file("src/x.ts", "await import(name);"),
          ]),
        ),
      ),
    ).toEqual(["apps/api/src/x.ts: import with a computed specifier"]);
  });

  it("refuses a computed import whatever relative text it starts with", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/core", "@sf/core", {}, [
            file(
              "src/x.ts",
              'await import("./" + "../../config/src/index.js");',
            ),
            file("src/y.ts", 'await import("../test-support" + "/fixture");'),
            file("src/z.ts", "await import(`./locales/${lang}.js`);"),
          ]),
        ),
      ),
    ).toEqual([
      "packages/core/src/x.ts: import with a computed specifier",
      "packages/core/src/y.ts: import with a computed specifier",
      "packages/core/src/z.ts: import with a computed specifier",
    ]);
  });

  it("refuses the files of a package the table does not know", () => {
    expect(
      importViolations([
        ...baseWorkspace(),
        pkg("packages/storage", "@sf/storage", {}, [
          file("src/x.ts", "export {};"),
        ]),
      ]),
    ).toEqual([
      "@sf/storage (packages/storage) is not in the table of allowed edges",
    ]);
  });
});

describe("the workspace", () => {
  const workspace = readWorkspace();

  it("reads every package of pnpm-workspace.yaml with its files", () => {
    // An empty read would pass the cases below on nothing.
    const dirs = workspacePackageDirs();
    expect(dirs.length).toBeGreaterThan(0);
    expect(workspace.map((entry) => entry.dir)).toEqual(dirs);
    const empty = workspace
      .filter((entry) => entry.files.length === 0)
      .map((entry) => `${entry.dir}: no source file read`);
    expect(empty).toEqual([]);
  });

  it("has a row of the table for every package and a package for every row", () => {
    expect(tableViolations(workspace)).toEqual([]);
  });

  it("has no manifest edge against the direction", () => {
    expect(manifestViolations(workspace)).toEqual([]);
  });

  it("has no import against the direction", () => {
    expect(importViolations(workspace)).toEqual([]);
  });
});
