import { beforeAll, describe, expect, it } from "vitest";
import {
  type EdgeTable,
  NEW_PACKAGE,
  type SourceFile,
  type StandardRule,
  type WorkspacePackage,
  devOnlyImports,
  directionRuleViolations,
  importViolations,
  manifestViolations,
  readImportForms,
  readStandardRules,
  readWorkspace,
  sourceFilesByPackage,
  tableViolations,
  undeclaredZodImports,
} from "./dependency-direction.js";
import { type Manifest, RULES_FILE, repoWorkspaceDirs } from "./repo-files.js";

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

  it("keeps the edges it refuses out of the rows it allows", () => {
    const allowed = new Map(ALLOWED);
    const both = REFUSED.filter(([name, to]) =>
      allowed.get(name)?.includes(to),
    );

    expect(both).toEqual([]);
  });

  it("allows every pair of packages exactly by the rows above: a row of the lock grown by any edge is red", () => {
    // Cross, not one refusal per row: an edge added to a row of
    // ALLOWED_EDGES that REFUSED does not name is caught here.
    const allowed = new Map(ALLOWED);
    const wrong: string[] = [];
    for (const [, name] of PACKAGES) {
      for (const [, to] of PACKAGES) {
        if (to === name) continue;
        const found = manifestViolations(
          withPackage(
            pkg(dirOf(name), name, { dependencies: { [to]: "workspace:*" } }),
          ),
        );
        const expected = allowed.get(name)?.includes(to) === true;
        if (expected !== (found.length === 0)) {
          wrong.push(`${name} -> ${to}: ${expected ? "refused" : "allowed"}`);
        }
      }
    }

    expect(wrong).toEqual([]);
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
        `apps/worker/src/main.ts: ${specifier} (test support from a file that ships)`,
      ]);
    },
  );

  it("refuses @sf/config in a module of src/cli/ that is no entry point reading it", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/cli/run.ts", 'import { env } from "@sf/config";'),
            file("src/cli/seed.ts", 'import { env } from "@sf/config";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/cli/run.ts: @sf/config (ADR-0002: only the CLI, tests and vitest configs)",
    ]);
  });

  it("refuses a library module of @sf/db that takes a module of src/cli/, and passes the CLI taking its own", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/lib.ts", 'import { run } from "./cli/run.js";'),
            file("src/repos/x.ts", 'export * from "../cli/seed.js";'),
            file("src/cli/migrate.ts", 'import { run } from "./run.js";'),
            file("src/client.ts", 'import { clientOptions } from "./cli.js";'),
            file(
              "test/cli.test.ts",
              'import { run } from "../src/cli/run.js";',
            ),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/lib.ts: ./cli/run.js (library code of @sf/db takes nothing from src/cli: ADR-0002)",
      "packages/db/src/repos/x.ts: ../cli/seed.js (library code of @sf/db takes nothing from src/cli: ADR-0002)",
    ]);
  });

  it.each([
    ["drizzle.config.ts", 'import "./src/cli/migrate.ts";'],
    ["drizzle.config.ts", 'import { run } from "./src/cli/run.js";'],
    ["scripts/x.mjs", 'import "../src/cli/seed.js";'],
  ])(
    "refuses %s of @sf/db, outside src/, taking a module of src/cli/: %s",
    (path, text) => {
      expect(
        importViolations(
          withPackage(pkg("packages/db", "@sf/db", {}, [file(path, text)])),
        ),
      ).toEqual([
        expect.stringContaining(
          `packages/db/${path}: ${/"(.+)"/.exec(text)?.[1]} (library code of @sf/db takes nothing from src/cli: ADR-0002)`,
        ),
      ]);
    },
  );

  it.each([
    ["test/migrate.test.ts", 'import { run } from "../src/cli/run.js";'],
    ["test-support/db.ts", 'import "../src/cli/migrate.js";'],
    ["vitest.config.ts", 'import "./src/cli/migrate.js";'],
  ])(
    "passes %s of @sf/db, which may read the configuration, taking src/cli/",
    (path, text) => {
      expect(
        importViolations(
          withPackage(pkg("packages/db", "@sf/db", {}, [file(path, text)])),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["apps/web", "@sf/web", "next.config.ts"],
    ["apps/worker", "@sf/worker", "scripts/x.mjs"],
    ["packages/db", "@sf/db", "drizzle.config.ts"],
  ])(
    "refuses the test support from %s/%s, a file that ships",
    (dir, name, path) => {
      // Its own test support: no edge of the table in the way.
      const specifier = `${name}/test-support/fixture`;
      expect(
        importViolations(
          withPackage(
            pkg(dir, name, {}, [
              file(path, `import { x } from "${specifier}";`),
              file("test/x.ts", `import { x } from "${specifier}";`),
              file("src/x.test.ts", `import { x } from "${specifier}";`),
              file("vitest.int.config.ts", `import "${specifier}";`),
            ]),
          ),
        ),
      ).toEqual([
        `${dir}/${path}: ${specifier} (test support from a file that ships)`,
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
        `${dir}/src/repos/x.ts: ../../test-support/fixture.js (test support from a file that ships)`,
      ]);
    },
  );

  it("refuses a relative path from drizzle.config.ts into the test support: the config ships", () => {
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("drizzle.config.ts", 'import "./test-support/x";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/drizzle.config.ts: ./test-support/x (test support from a file that ships)",
    ]);
  });

  it("lets a test under src take its own test support, and refuses its neighbour that ships", () => {
    // A test under src/ never ships: the images hold no test (`noTests` of
    // scripts/probe-image.mjs), ADR-0011.
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/a.test.ts", 'import { x } from "../test-support/x.js";'),
            file("src/a.ts", 'import { x } from "../test-support/x.js";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/a.ts: ../test-support/x.js (test support from a file that ships)",
    ]);
  });

  it("refuses test support to a test under src the preset does not run", () => {
    // The preset of ADR-0011 runs `*.test.ts` and `noTests` of
    // scripts/probe-image.mjs holds the images to that name only: a
    // `*.test.tsx` under src/ is a file that ships.
    expect(
      importViolations(
        withPackage(
          pkg("packages/db", "@sf/db", {}, [
            file("src/a.test.tsx", 'import { x } from "../test-support/x.js";'),
          ]),
        ),
      ),
    ).toEqual([
      "packages/db/src/a.test.tsx: ../test-support/x.js (test support from a file that ships)",
    ]);
  });

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
  // Read before the cases rather than when the file is collected: a git that
  // cannot list the tree is then a red case with its reason.
  let workspace: WorkspacePackage[] = [];
  beforeAll(() => {
    workspace = readWorkspace();
  });

  it("reads every package of pnpm-workspace.yaml with its files", () => {
    // An empty read would pass the cases below on nothing.
    const dirs = repoWorkspaceDirs();
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

  it("has the rules of standards in agreement with the table", () => {
    expect(workspace.length).toBeGreaterThan(0);
    expect(directionRuleViolations(readStandardRules(), workspace)).toEqual([]);
  });

  it("has every package declaring the zod it imports", () => {
    expect(undeclaredZodImports(workspace)).toEqual([]);
  });

  it("has no file that ships importing a package of devDependencies only", () => {
    expect(devOnlyImports(workspace)).toEqual([]);
  });
});

describe("sourceFilesByPackage", () => {
  it("gives a file to the deepest package that holds it, and none to a file of no package", () => {
    const owned = sourceFilesByPackage(
      [
        "packages/db/src/index.ts",
        "packages/db/tools/gen/src/main.ts",
        "packages/db/tools/gen/package.json",
        "packages/db/tools/readme.ts",
        "packages/integrations/youtube/src/data-api.ts",
        "vitest.preset.ts",
        "packages/dbx/src/index.ts",
      ],
      ["packages/db", "packages/db/tools/gen", "packages/integrations/youtube"],
    );

    expect(Object.fromEntries(owned)).toEqual({
      "packages/db": [
        "packages/db/src/index.ts",
        "packages/db/tools/readme.ts",
      ],
      "packages/db/tools/gen": ["packages/db/tools/gen/src/main.ts"],
      "packages/integrations/youtube": [
        "packages/integrations/youtube/src/data-api.ts",
      ],
    });
  });

  it("gives the same files whatever the order of the directories", () => {
    const files = ["a/b/c/x.ts", "a/b/y.ts", "a/z.ts"];

    expect(
      Object.fromEntries(sourceFilesByPackage(files, ["a/b/c", "a/b", "a"])),
    ).toEqual(
      Object.fromEntries(sourceFilesByPackage(files, ["a", "a/b", "a/b/c"])),
    );
  });
});

/**
 * The rules of standards against the table: S07, S11, S15 and S16 of
 * `.claude/hooks/rules.sf.json` each refuse, for their package, exactly the
 * `@sf/*` names the table does not allow, in every form of an import and
 * with every quote. Their patterns are run here as regular expressions: a
 * pattern that does not compile throws and the case is red with the reason -
 * stricter than the hook, which leaves such a rule off - and that is the
 * check, not a change of what the hook does. The rules of the repository
 * are checked in "the workspace" above.
 */
describe("the rules of standards against the table", () => {
  /**
   * The packages of the four rules, each with source files of its own: two
   * in contracts, so a rule narrowed to one of them is seen; web with a
   * config outside `src/`, which its rule does not have to take.
   */
  const OWNERS: WorkspacePackage[] = [
    pkg("packages/core", "@sf/core", {}, [
      file("src/index.ts", ""),
      file("test/index.test.ts", ""),
    ]),
    pkg("apps/web", "@sf/web", {}, [
      file("src/lib/api.server.ts", ""),
      file("next.config.ts", ""),
    ]),
    pkg("packages/contracts", "@sf/contracts", {}, [
      file("src/index.ts", ""),
      file("src/health.ts", ""),
    ]),
    pkg("packages/api-client", "@sf/api-client", {}, [
      file("src/index.ts", ""),
    ]),
  ];
  /** The owners and the packages of `names` besides them, with no files. */
  const withNames = (names: readonly string[]): WorkspacePackage[] => [
    ...OWNERS,
    ...names.map((name) => pkg(`packages/${name.slice(4)}`, name)),
  ];
  /** The owners and every other package of the table. */
  const WORKSPACE = withNames(
    PACKAGES.map(([, name]) => name).filter(
      (name) => !OWNERS.some((owner) => owner.manifest.name === name),
    ),
  );
  /** What comes before the name: `from`, `import`, `import(` and `require(`, then a quote. */
  const HEAD =
    "(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['\"`]";
  /** Where a name ends: a quote or a subpath. */
  const END = "['\"`/]";
  /** A rule over every form of an import that passes `allowed` and refuses every other `@sf/*`. */
  const rule = (
    id: string,
    allowed: string,
    extra: Partial<StandardRule> = {},
  ): StandardRule => ({
    id,
    files: ["**"],
    pattern: `${HEAD}@sf/(?!(?:${allowed})${END})`,
    ...extra,
  });
  const S11 = rule("S11", "", {
    pattern: `${HEAD}@sf/(?!(?:contracts|api-client|web)${END}|config/server['"\`])`,
  });
  const AGREEING: StandardRule[] = [
    rule("S07", "core"),
    S11,
    rule("S15", "core|contracts"),
    rule("S16", "contracts|api-client"),
  ];
  const replaced = (replacement: StandardRule): StandardRule[] =>
    AGREEING.map((existing) =>
      existing.id === replacement.id ? replacement : existing,
    );
  const TABLE: EdgeTable = {
    "@sf/core": [],
    "@sf/web": ["@sf/api-client", "@sf/contracts", "@sf/config"],
    "@sf/contracts": ["@sf/core"],
    "@sf/api-client": ["@sf/contracts"],
  };
  /** The lines of a rule of S16 that passes `@sf/core`, `@sf/web` and `NEW_PACKAGE`, each with a subpath, in `line`. */
  const s16Passes = (line: (specifier: string) => string): string[] =>
    ["@sf/core", "@sf/web", NEW_PACKAGE].flatMap((name) =>
      [name, `${name}/zz-sub`].map(
        (specifier) =>
          `S16 passes an edge the table does not have: @sf/api-client -> ${specifier}, in: ${line(specifier)}`,
      ),
    );

  it("passes rules that refuse exactly what the table does not allow", () => {
    expect(directionRuleViolations(AGREEING, WORKSPACE, TABLE)).toEqual([]);
  });

  it("names a rule that passes an edge the table does not have", () => {
    expect(
      directionRuleViolations(AGREEING, WORKSPACE, {
        ...TABLE,
        "@sf/api-client": [],
      }),
    ).toEqual([
      'S16 passes an edge the table does not have: @sf/api-client -> @sf/contracts, in: import { x } from "@sf/contracts";',
      'S16 passes an edge the table does not have: @sf/api-client -> @sf/contracts/zz-sub, in: import { x } from "@sf/contracts/zz-sub";',
    ]);
  });

  it("names a rule that refuses an edge of the table", () => {
    expect(
      directionRuleViolations(AGREEING, WORKSPACE, {
        ...TABLE,
        "@sf/contracts": ["@sf/core", "@sf/config"],
      }),
    ).toEqual([
      'S15 refuses an edge of the table: @sf/contracts -> @sf/config, in: import { x } from "@sf/config";',
      'S15 refuses an edge of the table: @sf/contracts -> @sf/config/zz-sub, in: import { x } from "@sf/config/zz-sub";',
    ]);
  });

  it("checks every form of an import: a rule that sees only from passes the rest", () => {
    const fromOnly = rule("S16", "contracts|api-client", {
      pattern: `\\bfrom\\s*['"\`]@sf/(?!(?:contracts|api-client)${END})`,
    });
    expect(
      directionRuleViolations(replaced(fromOnly), withNames([]), TABLE),
    ).toEqual(
      s16Passes((specifier) => `const m = await import("${specifier}");`),
    );
  });

  it("checks every quote: a rule that sees only the double one passes the rest", () => {
    const doubleOnly = rule("S16", "contracts|api-client", {
      pattern: `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)"@sf/(?!(?:contracts|api-client)["/])`,
    });
    expect(
      directionRuleViolations(replaced(doubleOnly), withNames([]), TABLE),
    ).toEqual(
      s16Passes((specifier) => `import type { X } from '${specifier}';`),
    );
  });

  it("checks a package nobody has yet, which a list of refused names passes", () => {
    const listed = rule("S11", "", {
      pattern: `${HEAD}@sf/(?:(?:api|worker|db|runtime|youtube|gemini|tts|core)${END}|config(?!/server['"\`]))`,
    });
    expect(directionRuleViolations(replaced(listed), WORKSPACE, TABLE)).toEqual(
      [
        `S11 passes an edge the table does not have: @sf/web -> ${NEW_PACKAGE}, in: import { x } from "${NEW_PACKAGE}";`,
        `S11 passes an edge the table does not have: @sf/web -> ${NEW_PACKAGE}/zz-sub, in: import { x } from "${NEW_PACKAGE}/zz-sub";`,
      ],
    );
  });

  it("holds web to exactly the server entry of @sf/config in its own code", () => {
    const root = rule("S11", "contracts|api-client|web|config");
    expect(directionRuleViolations(replaced(root), WORKSPACE, TABLE)).toEqual([
      'S11 passes an edge the table does not have: @sf/web -> @sf/config, in: import { x } from "@sf/config";',
      'S11 passes an edge the table does not have: @sf/web -> @sf/config/zz-sub, in: import { x } from "@sf/config/zz-sub";',
      'S11 passes an edge the table does not have: @sf/web -> @sf/config/server/zz-sub, in: import { x } from "@sf/config/server/zz-sub";',
    ]);
    const entry = rule("S11", "contracts|api-client|web");
    expect(directionRuleViolations(replaced(entry), WORKSPACE, TABLE)).toEqual([
      'S11 refuses an edge of the table: @sf/web -> @sf/config/server, in: import { x } from "@sf/config/server";',
    ]);
    const anySubpath = rule("S11", "", {
      pattern: `${HEAD}@sf/(?!(?:contracts|api-client|web)${END}|config/)`,
    });
    expect(
      directionRuleViolations(replaced(anySubpath), WORKSPACE, TABLE),
    ).toEqual([
      'S11 passes an edge the table does not have: @sf/web -> @sf/config/zz-sub, in: import { x } from "@sf/config/zz-sub";',
      'S11 passes an edge the table does not have: @sf/web -> @sf/config/server/zz-sub, in: import { x } from "@sf/config/server/zz-sub";',
    ]);
  });

  it("refuses the server entry of @sf/config to web when its row does not have @sf/config", () => {
    expect(
      directionRuleViolations(AGREEING, WORKSPACE, {
        ...TABLE,
        "@sf/web": ["@sf/api-client", "@sf/contracts"],
      }),
    ).toEqual([
      'S11 passes an edge the table does not have: @sf/web -> @sf/config/server, in: import { x } from "@sf/config/server";',
    ]);
  });

  it("checks where a name ends: a rule without the boundary passes a longer name", () => {
    const unbounded = rule("S15", "", {
      pattern: `${HEAD}@sf/(?!core|contracts)`,
    });
    expect(
      directionRuleViolations(
        replaced(unbounded),
        withNames(["@sf/corex"]),
        TABLE,
      ),
    ).toEqual([
      'S15 passes an edge the table does not have: @sf/contracts -> @sf/corex, in: import { x } from "@sf/corex";',
      'S15 passes an edge the table does not have: @sf/contracts -> @sf/corex/zz-sub, in: import { x } from "@sf/corex/zz-sub";',
    ]);
  });

  it("reads skipIf as the hook does: a skipped line is not refused", () => {
    expect(
      directionRuleViolations(
        replaced(rule("S16", "contracts|api-client", { skipIf: "\\{ x \\}" })),
        withNames([]),
        TABLE,
      ),
    ).toEqual(s16Passes((specifier) => `import { x } from "${specifier}";`));
  });

  it("reads a global pattern as the hook does, from the start of every line", () => {
    const global = AGREEING.map((existing) => ({ ...existing, flags: "g" }));
    expect(directionRuleViolations(global, WORKSPACE, TABLE)).toEqual([]);
  });

  it("names a rule whose files leave out any source file of its package, and a rule that is not a line rule", () => {
    const tests = rule("S15", "core|contracts", {
      files: ["packages/contracts/test/**"],
    });
    expect(directionRuleViolations(replaced(tests), WORKSPACE, TABLE)).toEqual([
      "S15: the files of the rule do not take packages/contracts/src/index.ts, packages/contracts/src/health.ts, of @sf/contracts",
    ]);
    const none = rule("S15", "core|contracts", { files: undefined });
    expect(directionRuleViolations(replaced(none), WORKSPACE, TABLE)).toEqual([
      "S15: the files of the rule do not take packages/contracts/src/index.ts, packages/contracts/src/health.ts, of @sf/contracts",
    ]);
    const oneFile = rule("S15", "core|contracts", {
      files: ["packages/contracts/src/index.ts"],
    });
    expect(
      directionRuleViolations(replaced(oneFile), WORKSPACE, TABLE),
    ).toEqual([
      "S15: the files of the rule do not take packages/contracts/src/health.ts, of @sf/contracts",
    ]);
    const near = rule("S15", "core|contracts", { kind: "near" });
    expect(directionRuleViolations(replaced(near), WORKSPACE, TABLE)).toEqual([
      "S15: kind near, a rule of direction is a line rule",
    ]);
  });

  it("reads an empty kind as a line rule, as the hook does", () => {
    const empty = rule("S15", "core|contracts", { kind: "" });
    expect(directionRuleViolations(replaced(empty), WORKSPACE, TABLE)).toEqual(
      [],
    );
  });

  it("holds the rule of web to its src/ only: a config outside it is not the rule's", () => {
    const src = { ...S11, files: ["apps/web/src/**"] };
    expect(directionRuleViolations(replaced(src), WORKSPACE, TABLE)).toEqual(
      [],
    );
  });

  it("names a package of a rule that is not in the workspace, or has no source file for the rule", () => {
    const withoutClient = WORKSPACE.filter(
      (entry) => entry.manifest.name !== "@sf/api-client",
    );
    expect(directionRuleViolations(AGREEING, withoutClient, TABLE)).toEqual([
      "S16: @sf/api-client is not in the workspace",
    ]);
    const webOutsideSrc = WORKSPACE.map((entry) =>
      entry.manifest.name === "@sf/web"
        ? { ...entry, files: [file("next.config.ts", "")] }
        : entry,
    );
    expect(directionRuleViolations(AGREEING, webOutsideSrc, TABLE)).toEqual([
      "S11: @sf/web has no source file for the files of the rule to take",
    ]);
  });

  it("names a package of a rule that has no row in the table", () => {
    const withoutCore = Object.fromEntries(
      Object.entries(TABLE).filter(([owner]) => owner !== "@sf/core"),
    );
    expect(directionRuleViolations(AGREEING, WORKSPACE, withoutCore)).toEqual([
      "S07: @sf/core is not in the table of allowed edges",
    ]);
  });

  it("names a rule that is not there", () => {
    expect(
      directionRuleViolations(
        AGREEING.filter((existing) => existing.id !== "S15"),
        WORKSPACE,
        TABLE,
      ),
    ).toEqual([`S15: no rule with this id in ${RULES_FILE}`]);
  });

  it("throws on a pattern that is not a regular expression", () => {
    expect(() =>
      directionRuleViolations(
        replaced(rule("S07", "core", { pattern: 'from\\s*"(' })),
        WORKSPACE,
        TABLE,
      ),
    ).toThrow(SyntaxError);
  });

  it("has one head and one skipIf for the four rules of direction in RULES_FILE", () => {
    const rules = readStandardRules();
    expect(rules.map((existing) => existing.id).sort()).toEqual([
      "S07",
      "S11",
      "S15",
      "S16",
    ]);
    // The text before the name, up to the end of the branches of the head:
    // the anchor is HEAD above, so the head itself is written nowhere here.
    const heads = rules.map(({ id, pattern }) => {
      const at = pattern.indexOf(HEAD);
      return at === -1
        ? `${id}: no ${HEAD}`
        : pattern.slice(0, at + HEAD.length);
    });
    expect(heads).toEqual(heads.map(() => heads[0]));
    const skips = rules.map(({ skipIf }) => skipIf);
    expect(skips).toEqual(skips.map(() => skips[0]));
  });
});

describe("readImportForms", () => {
  it("reads the table of .claude/hooks/import-forms.js with a form for every head", () => {
    const { IMPORT_HEADS, IMPORT_FORMS } = readImportForms();
    expect(
      IMPORT_HEADS.filter(
        (head) => !IMPORT_FORMS.some((entry) => entry.head === head),
      ),
    ).toEqual([]);
    expect(
      IMPORT_FORMS.map(({ form }) => form("@sf/zz-x")).filter(
        (line) => !line.includes("@sf/zz-x"),
      ),
    ).toEqual([]);
  });

  it("throws on a table of another shape: no forms, a head it does not name, a form that gives no line", () => {
    expect(() => readImportForms({ IMPORT_HEADS: ["from"] })).toThrow(
      /IMPORT_FORMS/,
    );
    expect(() =>
      readImportForms({
        IMPORT_HEADS: ["from"],
        IMPORT_FORMS: [{ head: "require", form: (spec: string) => spec }],
      }),
    ).toThrow(/IMPORT_HEADS does not have/);
    const { IMPORT_FORMS } = readImportForms({
      IMPORT_HEADS: ["from"],
      IMPORT_FORMS: [{ head: "from", form: () => 1 }],
    });
    expect(() => IMPORT_FORMS[0].form("x")).toThrow();
  });
});

describe("readStandardRules", () => {
  const FOUR = ["S07", "S11", "S15", "S16"].map((id) => ({
    id,
    kind: "line",
    files: ["**"],
    pattern: "x",
  }));

  it("reads the four rules of direction and passes over a rule without an id or of another id", () => {
    const others = [{ kind: "line", files: ["**"] }, { id: "S03" }];
    expect(readStandardRules([...others, ...FOUR])).toEqual(FOUR);
  });

  it("throws on a rule of direction of another shape", () => {
    const withoutPattern = FOUR.map((rule, index) =>
      index === 0 ? { ...rule, pattern: undefined } : rule,
    );
    expect(() => readStandardRules(withoutPattern)).toThrow(/pattern/);
  });
});

/**
 * `zod` declared by the package that imports it: the root manifest has it in
 * `devDependencies`, so a package that leaves it out still resolves it here
 * and fails only in an image installed with `--prod`. The packages of the
 * repository are checked in "the workspace" above.
 */
describe("undeclaredZodImports", () => {
  const ZOD_IMPORT = 'import { z } from "zod";\n';

  it("refuses a file that ships when the manifest does not name zod", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", {}, [file("src/index.ts", ZOD_IMPORT)]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([
      "packages/a/src/index.ts: zod is not in dependencies of packages/a/package.json",
    ]);
  });

  it("reads import() and require() of zod as imports", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", {}, [
        file("src/lazy.ts", 'const zod = await import("zod");\n'),
        file("src/common.cjs", 'const { z } = require("zod");\n'),
      ]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([
      "packages/a/src/lazy.ts: zod is not in dependencies of packages/a/package.json",
      "packages/a/src/common.cjs: zod is not in dependencies of packages/a/package.json",
    ]);
  });

  it("refuses a file that ships when zod is in devDependencies only, and a subpath the same", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", { devDependencies: { zod: "^3.23.0" } }, [
        file("src/index.ts", ZOD_IMPORT),
        file("src/v4.ts", 'import { z } from "zod/v4";\n'),
        file("test/index.test.ts", ZOD_IMPORT),
      ]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([
      "packages/a/src/index.ts: zod is not in dependencies of packages/a/package.json",
      "packages/a/src/v4.ts: zod is not in dependencies of packages/a/package.json",
    ]);
  });

  it("refuses a file that ships when zod is in peerDependencies or optionalDependencies only", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", { peerDependencies: { zod: "^3.23.0" } }, [
        file("src/index.ts", ZOD_IMPORT),
      ]),
      pkg("packages/b", "@sf/b", { optionalDependencies: { zod: "^3.23.0" } }, [
        file("src/index.ts", ZOD_IMPORT),
      ]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([
      "packages/a/src/index.ts: zod is not in dependencies of packages/a/package.json",
      "packages/b/src/index.ts: zod is not in dependencies of packages/b/package.json",
    ]);
  });

  it("takes devDependencies for a file that never ships outside test/: a test under src/, a vitest config", () => {
    const files = [
      file("src/index.test.ts", ZOD_IMPORT),
      file("vitest.config.ts", ZOD_IMPORT),
    ];
    expect(
      undeclaredZodImports([
        pkg(
          "packages/a",
          "@sf/a",
          { devDependencies: { zod: "^3.23.0" } },
          files,
        ),
      ]),
    ).toEqual([]);
    expect(
      undeclaredZodImports([pkg("packages/a", "@sf/a", {}, files)]),
    ).toEqual([
      "packages/a/src/index.test.ts: zod is not in dependencies or devDependencies of packages/a/package.json",
      "packages/a/vitest.config.ts: zod is not in dependencies or devDependencies of packages/a/package.json",
    ]);
  });

  it("refuses a test when zod is in neither field", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", {}, [file("test/index.test.ts", ZOD_IMPORT)]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([
      "packages/a/test/index.test.ts: zod is not in dependencies or devDependencies of packages/a/package.json",
    ]);
  });

  it("passes zod in dependencies, a file that does not import it, and a name that only starts with zod", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", { dependencies: { zod: "^3.23.0" } }, [
        file("src/index.ts", ZOD_IMPORT),
      ]),
      pkg("packages/b", "@sf/b", {}, [
        file("src/index.ts", 'import { x } from "zodx";\n// from "zod"\n'),
      ]),
    ];
    expect(undeclaredZodImports(workspace)).toEqual([]);
  });
});

/**
 * A package of `devDependencies` only, imported by a file that ships: the
 * images install with `--prod`, so the import fails there (E0-12V:
 * `vitest` in `packages/core/src`). The packages of the repository are
 * checked in "the workspace" above.
 */
describe("devOnlyImports", () => {
  const VITEST_IMPORT = 'import { describe } from "vitest";\n';
  const DEV = { devDependencies: { vitest: "^3.0.0" } };

  it("refuses a file that ships and imports a package of devDependencies only", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", DEV, [
        file("src/x.ts", VITEST_IMPORT),
        file("src/lazy.ts", 'const v = await import("vitest/config");\n'),
        file("index.ts", 'const { vi } = require("vitest");\n'),
      ]),
    ];
    expect(devOnlyImports(workspace)).toEqual([
      "packages/a/src/x.ts: vitest is only in devDependencies of packages/a/package.json, and the file ships",
      "packages/a/src/lazy.ts: vitest is only in devDependencies of packages/a/package.json, and the file ships",
      "packages/a/index.ts: vitest is only in devDependencies of packages/a/package.json, and the file ships",
    ]);
  });

  it("names a scoped package by its scope and name", () => {
    const workspace = [
      pkg(
        "packages/a",
        "@sf/a",
        { devDependencies: { "@scope/dev": "^1.0.0" } },
        [file("src/x.ts", 'import { x } from "@scope/dev/sub";\n')],
      ),
    ];
    expect(devOnlyImports(workspace)).toEqual([
      "packages/a/src/x.ts: @scope/dev is only in devDependencies of packages/a/package.json, and the file ships",
    ]);
  });

  it("passes a file that never ships: a test under src/, a test under test/, a vitest config", () => {
    const workspace = [
      pkg("packages/a", "@sf/a", DEV, [
        file("src/x.test.ts", VITEST_IMPORT),
        file("test/x.ts", VITEST_IMPORT),
        file(
          "vitest.config.ts",
          'import { defineConfig } from "vitest/config";\n',
        ),
      ]),
    ];
    expect(devOnlyImports(workspace)).toEqual([]);
  });

  it("refuses vitest in a source file of packages/core", () => {
    const workspace = [
      pkg("packages/core", "@sf/core", DEV, [
        file("src/x.ts", 'import { vi } from "vitest";\n'),
      ]),
    ];
    expect(devOnlyImports(workspace)).toEqual([
      "packages/core/src/x.ts: vitest is only in devDependencies of packages/core/package.json, and the file ships",
    ]);
  });

  it("passes a type-only import of a package of devDependencies only, and refuses its value and inline type imports", () => {
    const workspace = [
      pkg("apps/api", "@sf/api", { devDependencies: { ioredis: "^5.0.0" } }, [
        file(
          "src/types.ts",
          [
            'import type { Redis } from "ioredis";',
            'type R = typeof import("ioredis");',
            'export type { RedisOptions } from "ioredis";',
          ].join("\n"),
        ),
        file("src/value.ts", 'import { Redis } from "ioredis";\n'),
        file("src/inline.ts", 'import { type Redis } from "ioredis";\n'),
      ]),
    ];
    expect(devOnlyImports(workspace)).toEqual([
      "apps/api/src/value.ts: ioredis is only in devDependencies of apps/api/package.json, and the file ships",
      "apps/api/src/inline.ts: ioredis is only in devDependencies of apps/api/package.json, and the file ships",
    ]);
  });

  it("passes drizzle.config.ts, which only drizzle-kit reads", () => {
    const workspace = [
      pkg(
        "packages/db",
        "@sf/db",
        { devDependencies: { "drizzle-kit": "^0.30.0" } },
        [
          file(
            "drizzle.config.ts",
            'import { defineConfig } from "drizzle-kit";\n',
          ),
        ],
      ),
    ];
    expect(devOnlyImports(workspace)).toEqual([]);
  });

  it("passes a package in dependencies, a relative path, a builtin and a name only in neither field", () => {
    const workspace = [
      pkg(
        "packages/a",
        "@sf/a",
        {
          dependencies: { vitest: "^3.0.0" },
          devDependencies: { vitest: "^3.0.0" },
        },
        [file("src/x.ts", VITEST_IMPORT)],
      ),
      pkg("packages/b", "@sf/b", DEV, [
        file(
          "src/x.ts",
          'import { y } from "./vitest";\nimport { readFileSync } from "node:fs";\nimport { z } from "zod";\nimport { v } from "vitestx";\n',
        ),
      ]),
    ];
    expect(devOnlyImports(workspace)).toEqual([]);
  });
});
