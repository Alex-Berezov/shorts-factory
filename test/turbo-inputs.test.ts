import { describe, expect, it } from "vitest";
import {
  type Manifest,
  type Turbo,
  TurboSchema,
  readManifest,
  readRepoFile,
  readTurbo,
  repoFilesUnder,
  repoWorkspaceDirs,
} from "./repo-files.js";
import { rootReads } from "./root-reads.js";

/**
 * The turbo hash of a task is only as good as its inputs: a file that changes
 * the result of a task but not its hash gives a green run from the cache while
 * the code is red, and a file in the hash that the task never reads resets
 * the cache for nothing.
 *
 * - The `test` of every package hashes its own files and the vitest preset
 *   (`turbo.json`); the root env files only where a package reads them - its
 *   own `turbo.json` adds `$TURBO_ROOT$/.env.test` (and `.env.example` for
 *   `@sf/config`), keeping what it inherits through `$TURBO_EXTENDS$`.
 * - The tasks of the root project (`//#test:repo`, `//#typecheck:repo`) hash
 *   every file git tracks (`$TURBO_DEFAULT$` of a root task,
 *   docs/adr/0011-vitest-preset-and-test-support.md). So a test of the root
 *   project may read any file the hash covers and is replayed only when none
 *   of them changed - and must read no ignored one (generated, or in
 *   `.gitignore`): its change would not reach the hash, and CI would replay
 *   the old result from its cache.
 * - A unit test of a package that reads a file of the root (through
 *   `repoRoot`, or a relative path climbing out of the package) sees a
 *   change of it only if that file is in its inputs or of a dependency it
 *   hashes. Such readers are a fixed list below, each checked by hand: a new
 *   one is red until it is looked at and added.
 * - A root reader closed by an input keeps that input in the `turbo.json`
 *   of its package (`CLOSED_BY_INPUT`).
 *
 * Each rule is a function over parsed JSON, checked once on the files of the
 * repository and once on a broken copy, so a rule that cannot turn red is
 * red here.
 */

const DEFAULT = "$TURBO_DEFAULT$";
const EXTENDS = "$TURBO_EXTENDS$";
const PRESET = "$TURBO_ROOT$/vitest.preset.ts";
const ENV_TEST = "$TURBO_ROOT$/.env.test";
const ENV_EXAMPLE = "$TURBO_ROOT$/.env.example";
const ROOT_TASKS = ["//#test:repo", "//#typecheck:repo"];

/** One package of the workspace as the rules see it. */
interface PackageInputs {
  /** Path from the root, `apps/api`. */
  dir: string;
  /** Its `turbo.json`, undefined when it has none. */
  turbo: Turbo | undefined;
  /** The root files its unit tests read: `.env.test`, `.env.example`. */
  reads: { envTest: boolean; envExample: boolean };
  /** Its unit files outside `src/` that read a file of the root. */
  rootReaders: string[];
}

/** Rules (a) and (d): the inputs of the root `turbo.json`. */
function rootInputViolations(turbo: Turbo): string[] {
  const problems: string[] = [];
  const test = turbo.tasks.test?.inputs;
  if (JSON.stringify(test) !== JSON.stringify([DEFAULT, PRESET])) {
    problems.push(
      `turbo.json: test.inputs is ${JSON.stringify(test)}, not exactly ${DEFAULT} and ${PRESET} - a root file there resets the cache of every package`,
    );
  }
  for (const name of ROOT_TASKS) {
    const task = turbo.tasks[name];
    if (task === undefined) {
      problems.push(`turbo.json: no task ${name}`);
      continue;
    }
    const inputs = task.inputs;
    if (inputs !== undefined && !inputs.includes(DEFAULT)) {
      problems.push(
        `turbo.json: ${name}.inputs lacks ${DEFAULT} - the root project reads files of the whole repository`,
      );
    }
    for (const input of inputs ?? []) {
      if (input.startsWith("!")) {
        problems.push(
          `turbo.json: ${name}.inputs excludes ${input.slice(1)} - a file a root test reads would leave the hash`,
        );
      }
    }
  }
  return problems;
}

/** Rules (b) and (c): the `turbo.json` of each package against what it reads. */
function packageInputViolations(packages: PackageInputs[]): string[] {
  const problems: string[] = [];
  for (const { dir, turbo, reads } of packages) {
    const file = `${dir}/turbo.json`;
    if (turbo !== undefined) {
      if (JSON.stringify(turbo.extends) !== JSON.stringify(["//"])) {
        problems.push(`${file}: extends is not ["//"]`);
      }
      for (const [name, task] of Object.entries(turbo.tasks)) {
        if (task.inputs !== undefined && !task.inputs.includes(EXTENDS)) {
          problems.push(
            `${file}: ${name}.inputs lacks ${EXTENDS} - the inputs of the root turbo.json would be dropped`,
          );
        }
      }
    }
    const inputs = turbo?.tasks.test?.inputs ?? [];
    for (const [input, read] of [
      [ENV_TEST, reads.envTest],
      [ENV_EXAMPLE, reads.envExample],
    ] as const) {
      if (read && !inputs.includes(input)) {
        problems.push(
          `${dir}: its tests read ${input}, but test.inputs of ${file} lacks it - a change would replay a green run`,
        );
      }
      if (!read && inputs.includes(input)) {
        problems.push(
          `${dir}: test.inputs of ${file} has ${input}, which its tests do not read - a change would reset the cache for nothing`,
        );
      }
    }
  }
  return problems;
}

/**
 * Rule (e), :531 of docs/TECH_DEBT.md: the integration runs of api and worker
 * start after the one of `@sf/db`, which resets and migrates the database
 * they work on. turbo gives that order through the graph: `test:int` depends
 * on `^test:int`, and both apps depend on `@sf/db`.
 */
function intOrderViolations(
  turbo: Turbo,
  manifests: Record<string, Manifest>,
): string[] {
  const problems: string[] = [];
  if (!turbo.tasks["test:int"]?.dependsOn?.includes("^test:int")) {
    problems.push(
      "turbo.json: test:int does not depend on ^test:int - api and worker could run before @sf/db migrated",
    );
  }
  const db = manifests["packages/db"];
  if (db?.name !== "@sf/db" || db.scripts?.["test:int"] === undefined) {
    problems.push("packages/db: no @sf/db with a test:int script");
  }
  for (const dir of ["apps/api", "apps/worker"]) {
    const manifest = manifests[dir];
    if (manifest?.dependencies?.["@sf/db"] === undefined) {
      problems.push(
        `${dir}: @sf/db is not among its dependencies - ^test:int would not order its test:int after @sf/db#test:int`,
      );
    }
  }
  return problems;
}

/** A source file of a package, by its extension. */
const SOURCE = /\.[cm]?[jt]sx?$/;

/** The names through which a file of `@sf/config` reads the root. */
const ROOT_NAMES = ["repoRoot", "rootEnvFilePath", "testEnvFilePath"];

/**
 * Whether a unit file reads a file of the root, by what `rootReads`
 * (`test/root-reads.ts`) finds in its syntax tree: it names `repoRoot`,
 * `rootEnvFilePath` or `testEnvFilePath`; or a path tied to the file climbs
 * more `..` than the directories between the package and the file (`depth`:
 * 1 for `test/`), so `"../../.."` from `test/` and `"../../apps/worker"`
 * from `test/` both count; or a path tied to nothing climbs at all - it is
 * taken from the package directory, where vitest runs, so `"../core/src"`
 * and `resolve(packageDir, "..", "core")` count. Comments, regular
 * expressions (a backquote in one included) and the text of templates are
 * the parser's to tell apart; `"..\.."` climbs as `"../.."`. Not seen: what
 * `rootReads` names as not seen - a path built from variables or calls
 * (`dirname(dirname(here))`, `"..".repeat(3)`), a tie to the file through
 * anything but a `const` of the file.
 */
function readsRoot(
  code: string,
  depth: number,
  file = "test/x.test.ts",
): boolean {
  const found = rootReads(file, code);
  return (
    ROOT_NAMES.some((name) => found.names.has(name)) ||
    found.fileClimb > depth ||
    found.packageClimb > 0
  );
}

/** An integration file: `pnpm test` never runs it, its reads are not of the unit hash. */
const INT_FILE = /\.int(?:\.test)?\.ts$|vitest\.int\.config\.[cm]?[jt]s$/;

/**
 * What the unit tests of a package read of the root, by the syntax tree of
 * its unit files: the setup of `@sf/config` in its unit vitest config loads
 * `.env.test`, any other file that names a root env file (in a string, or
 * `testEnvFilePath`) is taken to read it, and a file outside `src/` that
 * reaches the root (`readsRoot`) is a root reader.
 */
function readsOf(
  dir: string,
  files: readonly string[],
): Pick<PackageInputs, "reads" | "rootReaders"> {
  const unit = files.filter(
    (file) =>
      file.startsWith(`${dir}/`) && SOURCE.test(file) && !INT_FILE.test(file),
  );
  const codes = unit.map((file) => {
    const code = readRepoFile(file);
    return { file, code, found: rootReads(file, code) };
  });
  const mentions = (needle: string): boolean =>
    codes.some(({ found }) =>
      found.strings.some((text) => text.includes(needle)),
    );
  return {
    reads: {
      envTest:
        mentions("@sf/config/vitest/setup") ||
        mentions(".env.test") ||
        codes.some(({ found }) => found.names.has("testEnvFilePath")),
      envExample: mentions(".env.example"),
    },
    rootReaders: codes
      .filter(
        ({ file, code }) =>
          !file.startsWith(`${dir}/src/`) &&
          readsRoot(code, depthOf(dir, file), file),
      )
      .map(({ file }) => file),
  };
}

/** Directories between the package at `dir` and its `file`: 1 for `test/x.ts`. */
function depthOf(dir: string, file: string): number {
  return file.slice(dir.length + 1).split("/").length - 1;
}

/** The repository as the rules see it. */
interface Repository {
  root: Turbo;
  packages: PackageInputs[];
  manifests: Record<string, Manifest>;
}

let read: Repository | undefined;

/**
 * The repository, read on the first case that asks rather than when the
 * file is collected: a git that cannot list the tree is then a red case with
 * its reason, not a file that failed to load.
 */
function repository(): Repository {
  if (read !== undefined) return read;
  const files = repoFilesUnder(".");
  const dirs = repoWorkspaceDirs();
  read = {
    root: readTurbo("."),
    packages: dirs.map((dir) => ({
      dir,
      turbo: files.includes(`${dir}/turbo.json`) ? readTurbo(dir) : undefined,
      ...readsOf(dir, files),
    })),
    manifests: Object.fromEntries(dirs.map((dir) => [dir, readManifest(dir)])),
  };
  return read;
}

/**
 * The unit files of packages that read a file of the root today, each looked
 * at: the tests of `@sf/config` read the root env files (in its inputs) and
 * check `repoRoot` itself; the healthcheck walk of the worker reads only the
 * packages its own walk holds to its hashed dependencies. The public surface
 * test of `@sf/db` resolves modules from `apps/worker` - closed by an input:
 * `$TURBO_ROOT$/apps/worker/package.json` in `packages/db/turbo.json`. The
 * setup of `@sf/config` (`vitest/setup.ts`) and the stack guard test of
 * `@sf/db` read `.env.test` through `testEnvFilePath` - in the inputs of both
 * packages (rule (c)).
 */
const ROOT_READERS = [
  "apps/worker/test/healthcheck-imports.test.ts",
  "packages/config/test/env-example.test.ts",
  "packages/config/test/env-file.test.ts",
  "packages/config/test/exports.test.ts",
  "packages/config/test/load-env.test.ts",
  "packages/config/vitest/setup.ts",
  "packages/db/test/public-surface.test.ts",
  "packages/db/test/stack-guard.test.ts",
];

/**
 * The root readers of `ROOT_READERS` closed by an input, each with that input:
 * the reader sees a change of the file only while the `turbo.json` of its
 * package keeps it in `test.inputs`.
 */
const CLOSED_BY_INPUT: Record<string, string> = {
  "packages/db/test/public-surface.test.ts":
    "$TURBO_ROOT$/apps/worker/package.json",
};

/** Rule (g): a root reader closed by an input keeps it in its package. */
function closedReaderViolations(
  packages: PackageInputs[],
  closed: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [reader, input] of Object.entries(closed)) {
    const owner = packages.find(({ dir }) => reader.startsWith(`${dir}/`));
    if (owner === undefined) {
      problems.push(`${reader}: no package of the workspace holds it`);
      continue;
    }
    if (!(owner.turbo?.tasks.test?.inputs ?? []).includes(input)) {
      problems.push(
        `${owner.dir}: ${reader} is closed by ${input}, but test.inputs of ${owner.dir}/turbo.json lacks it - a change would replay a green run`,
      );
    }
  }
  return problems;
}

describe("turbo inputs of the repository", () => {
  it("finds the packages and their readers by a scan", () => {
    const { packages } = repository();
    const readers = packages.filter((pkg) => pkg.reads.envTest);

    expect(packages.length).toBeGreaterThanOrEqual(9);
    // What the scan finds today; a new reader is caught by the rules below.
    expect(readers.map((pkg) => pkg.dir)).toEqual(
      expect.arrayContaining([
        "apps/api",
        "apps/worker",
        "packages/config",
        "packages/db",
        "packages/runtime",
      ]),
    );
    for (const dir of [
      "packages/core",
      "packages/contracts",
      "packages/api-client",
    ]) {
      expect(packages.find((pkg) => pkg.dir === dir)?.reads, dir).toEqual({
        envTest: false,
        envExample: false,
      });
    }
  });

  it("knows every unit file of a package that reads a file of the root", () => {
    expect(
      repository()
        .packages.flatMap((pkg) => pkg.rootReaders)
        .sort(),
    ).toEqual(ROOT_READERS);
  });

  it("keeps the input that closes each root reader in the turbo.json of its package", () => {
    expect(
      Object.keys(CLOSED_BY_INPUT).every((reader) =>
        ROOT_READERS.includes(reader),
      ),
    ).toBe(true);
    expect(
      closedReaderViolations(repository().packages, CLOSED_BY_INPUT),
    ).toEqual([]);
  });

  it("hashes the root test inputs exactly, and the whole repository for the root tasks", () => {
    expect(rootInputViolations(repository().root)).toEqual([]);
  });

  it("gives every package that reads a root env file that file, and no other package", () => {
    expect(packageInputViolations(repository().packages)).toEqual([]);
  });

  it("orders the integration runs of api and worker after the one of @sf/db", () => {
    const { root, manifests } = repository();
    expect(intOrderViolations(root, manifests)).toEqual([]);
  });
});

/**
 * The base of the broken copies of rule (d): the root `turbo.json` with the
 * fields of rule (a) set to what that rule wants, so a case of (d) sees the
 * one violation it makes, whatever (a) says of the file on disk.
 */
function baseOfD(from: Turbo): Turbo {
  const base = TurboSchema.parse(structuredClone(from));
  base.tasks.test = { ...base.tasks.test, inputs: [DEFAULT, PRESET] };
  return base;
}

describe("turbo input rules on broken copies", () => {
  const clean = (): Turbo =>
    TurboSchema.parse(structuredClone(repository().root));
  const pkg = (
    turbo: Turbo | undefined,
    reads: PackageInputs["reads"],
  ): PackageInputs => ({ dir: "packages/x", turbo, reads, rootReaders: [] });
  const testInputs = (inputs: string[]): Turbo => ({
    extends: ["//"],
    tasks: { test: { inputs } },
  });

  it("(a) refuses a root env file among the root test inputs", () => {
    const broken = clean();
    broken.tasks.test = { inputs: [DEFAULT, PRESET, ENV_TEST] };

    expect(rootInputViolations(broken)).toEqual([
      expect.stringContaining("test.inputs is"),
    ]);
  });

  it("(a) refuses root test inputs without the preset", () => {
    const broken = clean();
    broken.tasks.test = { inputs: [DEFAULT] };

    expect(rootInputViolations(broken)).toHaveLength(1);
  });

  it("(b) refuses a package turbo.json that does not extend the root", () => {
    const broken = { ...testInputs([EXTENDS, ENV_TEST]), extends: [] };

    expect(
      packageInputViolations([
        pkg(broken, { envTest: true, envExample: false }),
      ]),
    ).toEqual([expect.stringContaining("extends is not")]);
  });

  it("(b) refuses package inputs that drop the inherited ones", () => {
    expect(
      packageInputViolations([
        pkg(testInputs([ENV_TEST]), { envTest: true, envExample: false }),
      ]),
    ).toEqual([expect.stringContaining(`lacks ${EXTENDS}`)]);
  });

  it("(c) refuses a reader of .env.test without it in its inputs", () => {
    expect(
      packageInputViolations([
        pkg(undefined, { envTest: true, envExample: false }),
      ]),
    ).toEqual([expect.stringContaining(`read ${ENV_TEST}`)]);
  });

  it("(c) refuses a reader of .env.example without it in its inputs", () => {
    expect(
      packageInputViolations([
        pkg(testInputs([EXTENDS, ENV_TEST]), {
          envTest: true,
          envExample: true,
        }),
      ]),
    ).toEqual([expect.stringContaining(`read ${ENV_EXAMPLE}`)]);
  });

  it("(c) refuses a root env file in the inputs of a package that does not read it", () => {
    expect(
      packageInputViolations([
        pkg(testInputs([EXTENDS, ENV_TEST]), {
          envTest: false,
          envExample: false,
        }),
      ]),
    ).toEqual([expect.stringContaining("do not read")]);
  });

  it("(d) builds its copies on a base that rule (a) passes, whatever the root says", () => {
    const brokenA = clean();
    brokenA.tasks.test = { inputs: [DEFAULT, ENV_TEST] };

    expect(rootInputViolations(baseOfD(brokenA))).toEqual([]);
  });

  it.each(ROOT_TASKS)(
    "(d) refuses an exclusion in the inputs of %s",
    (name) => {
      const broken = baseOfD(clean());
      broken.tasks[name] = { inputs: [DEFAULT, "!scripts/**"] };

      expect(rootInputViolations(broken)).toEqual([
        expect.stringContaining(`${name}.inputs excludes scripts/**`),
      ]);
    },
  );

  it.each(ROOT_TASKS)(
    "(d) refuses inputs of %s without the default",
    (name) => {
      const broken = baseOfD(clean());
      broken.tasks[name] = { inputs: ["scripts/**"] };

      expect(rootInputViolations(broken)).toEqual([
        expect.stringContaining(`${name}.inputs lacks ${DEFAULT}`),
      ]);
    },
  );

  it("(e) refuses test:int without ^test:int", () => {
    const broken = clean();
    broken.tasks["test:int"] = { dependsOn: [] };

    expect(intOrderViolations(broken, repository().manifests)).toEqual([
      expect.stringContaining("does not depend on ^test:int"),
    ]);
  });

  it("(g) refuses a closed root reader whose package dropped the input", () => {
    const db = repository().packages.find(({ dir }) => dir === "packages/db");
    if (db?.turbo === undefined)
      throw new Error("no turbo.json of packages/db");
    const broken = TurboSchema.parse(structuredClone(db.turbo));
    broken.tasks.test = {
      inputs: (broken.tasks.test?.inputs ?? []).filter(
        (input) =>
          input !== CLOSED_BY_INPUT["packages/db/test/public-surface.test.ts"],
      ),
    };

    expect(
      closedReaderViolations([{ ...db, turbo: broken }], CLOSED_BY_INPUT),
    ).toEqual([
      expect.stringContaining(
        "packages/db: packages/db/test/public-surface.test.ts is closed by",
      ),
    ]);
  });

  it.each<[string, number, boolean, string?]>([
    // Named roots.
    ['import { repoRoot } from "@sf/config/paths";', 1, true],
    ['import { rootEnvFilePath } from "@sf/config/paths";', 1, true],
    ["const env = readFileSync(testEnvFilePath, 'utf8');", 1, true],
    // Climbs tied to the file, from its directory.
    ['const root = new URL("../../../", import.meta.url);', 1, true],
    ['const root = new URL("../../..", import.meta.url);', 1, true],
    ['const root = resolve(import.meta.dirname, "..", "..", "..");', 1, true],
    [
      'const here = dirname(fileURLToPath(import.meta.url));\nconst root = resolve(\n  here,\n  "..",\n  "..",\n  "..",\n);',
      1,
      true,
    ],
    ['const root = join(__dirname, "..\\\\..\\\\..");', 1, true],
    [
      'const here = dirname(fileURLToPath(import.meta.url));\nconst pkg = resolve(here, "..", "src");',
      1,
      false,
    ],
    ['const src = new URL("../src/x.ts", import.meta.url);', 1, false],
    ['await import("../../src/index.js");', 2, false],
    ['import { a } from "../src/a.js";', 1, false],
    // Climbs tied to nothing, from the package directory vitest runs in.
    ['const root = join(dir, "../../..");', 1, true],
    ['const app = resolve(packageDir, "../../apps/worker");', 1, true],
    ['const core = resolve(packageDir, "..", "core");', 1, true],
    ['const core = readFileSync("../core/src/index.ts", "utf8");', 1, true],
    ['const pkg = resolve(here, "..", "src");', 1, true],
    // The preset, the import of a vitest config only.
    [
      'import { unitTestConfig } from "../../vitest.preset.js";',
      0,
      false,
      "vitest.config.ts",
    ],
    ['import { unitTestConfig } from "../../vitest.preset.js";', 1, true],
    [
      'import { unitTestConfig } from "../../vitest.preset.js"; const r = repoRoot;',
      0,
      true,
      "vitest.config.ts",
    ],
    // What the parser tells apart.
    ["// the root is repoRoot, but nothing here reads it", 1, false],
    ["/* ../../../.env.test */ export const a = 1;", 1, false],
    [
      'const files = glob("**/*.ts");\nimport { repoRoot } from "@sf/config/paths";\n/** Reads the root. */',
      1,
      true,
    ],
    ['const url = "https://x//y"; const root = repoRoot;', 1, true],
    ["const comment = /\\/\\//; // repoRoot", 1, false],
    ["const re = /`/; const root = repoRoot;", 1, true],
  ])(
    "(f) takes %j from depth %i for a reader of the root: %s",
    (code, depth, reads, file = "test/x.test.ts") => {
      expect(readsRoot(code, depth, file)).toBe(reads);
    },
  );

  it.each(["apps/api", "apps/worker"])(
    "(e) refuses a manifest of %s without @sf/db",
    (dir) => {
      const { root, manifests } = repository();
      const manifest = manifests[dir];
      if (manifest === undefined) throw new Error(`no manifest of ${dir}`);
      const { "@sf/db": _db, ...dependencies } = manifest.dependencies ?? {};

      expect(
        intOrderViolations(root, {
          ...manifests,
          [dir]: { ...manifest, dependencies },
        }),
      ).toEqual([expect.stringContaining(`${dir}: @sf/db is not among`)]);
    },
  );
});

describe("turbo cache hash", () => {
  it("includes tsconfig.base.json, which every package's typecheck extends", () => {
    expect(repository().root.globalDependencies).toContain(
      "tsconfig.base.json",
    );
  });

  // The test of a package hashes the files of its internal dependencies
  // through these nodes (docs/TECH_DEBT.md, the worker#test row).
  it("makes test depend on the test of the internal dependencies", () => {
    expect(repository().root.tasks.test?.dependsOn).toContain("^test");
  });

  // api and worker integration tests share one Postgres and one Redis (db 1:
  // the heartbeat key, system.dlq); two at a time make CI flap.
  it("runs the integration tests of the packages one at a time", () => {
    const script = readManifest(".").scripts?.["test:int"];

    expect(script).toMatch(/^turbo run test:int(?: \S+)*$/);
    expect(script?.match(/--concurrency\S*/g)).toEqual(["--concurrency=1"]);
  });

  it("stores the build without the cache of Next", () => {
    expect(repository().root.tasks.build?.outputs).toContain(".next/**");
    expect(repository().root.tasks.build?.outputs).toContain("!.next/cache/**");
  });

  it("is pinned at or above 2.10, the turbo whose hashing E0-12 checked", () => {
    const turbo = readManifest(".").devDependencies?.turbo ?? "";
    const lower = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(turbo);

    expect(lower, `turbo range "${turbo}"`).not.toBeNull();
    const [major = 0, minor = 0] = (lower ?? []).slice(1).map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(2 * 1000 + 10);
  });
});
