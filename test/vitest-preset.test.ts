import { createRequire } from "node:module";
import { join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  type EntryCheck,
  type IntTestOptions,
  entryCheckModule,
  intTestConfig,
  unitTestConfig,
} from "../vitest.preset.js";
import {
  readManifest,
  readRepoFile,
  repoFileExists,
  repoFilesUnder,
  repoWorkspaceDirs,
} from "./repo-files.js";

/**
 * The preset is the one place the test policy of the workspace is written
 * down (docs/adr/0011-vitest-preset-and-test-support.md). What this file
 * guards is that it stays the one place: a package config that sets its own
 * `include` or forgets the preset is a copy again, and the integration runs
 * are only safe while their files run one at a time.
 *
 * Keys only the preset may set: who runs what, where, how many at once, and
 * what checks the stack before the first file.
 */
const PRESET_KEYS = [
  "include",
  "exclude",
  "environment",
  "fileParallelism",
  "globalSetup",
];

const PRESET_IMPORT = /from\s+"(?:\.\.\/)+vitest\.preset\.js"/;

/** Every name vitest loads a config under: `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. */
const CONFIG_FILE = /^vitest.*\.config\.[cm]?[jt]s$/;

/**
 * The vitest configs at the top of the package at `dir` (from the root), as
 * paths from the root, among the files the hash covers (`repoFilesUnder`):
 * an ignored one is in no hash, and what it holds must not change a result.
 */
function configsOf(dir: string): string[] {
  return repoFilesUnder(dir).filter((path) => {
    const name = path.slice(dir.length + 1);
    return !name.includes("/") && CONFIG_FILE.test(name);
  });
}

const ENTRY_CHECKS: readonly EntryCheck[] = ["postgres", "migrated-stack"];

/**
 * The entry check of each integration run: `@sf/db` resets and migrates the
 * database itself, the api and the worker work on what it migrated.
 */
const ENTRY_CHECK_OF: Record<string, EntryCheck> = {
  "packages/db": "postgres",
  "apps/api": "migrated-stack",
  "apps/worker": "migrated-stack",
};

/**
 * `key` as an object key - `key:` bare or quoted, or the shorthand `{ key }` -
 * and not as part of a longer name.
 */
function setsKey(source: string, key: string): boolean {
  return (
    new RegExp(`(?:^|[^\\w$])(["'\`]?)${key}\\1\\s*:`, "m").test(source) ||
    new RegExp(`[{,]\\s*${key}\\s*[,}]`, "m").test(source)
  );
}

/**
 * A config module as vitest loads it, by the keys of its `test` the
 * integration runs must have; the values are the cases' to compare.
 */
const LoadedConfigSchema = z.object({
  default: z.object({
    test: z.object({
      globalSetup: z.unknown(),
      fileParallelism: z.unknown(),
      setupFiles: z.unknown(),
    }),
  }),
});

/** The scripts of the package at `dir`, none when its manifest has none. */
function scriptsOf(dir: string): Record<string, string> {
  return readManifest(dir).scripts ?? {};
}

/** The config file a `vitest run` script reads (`--config <file>` or the default). */
function configOfScript(script: string): string {
  const match = /(?:^|\s)--config(?:=|\s+)(\S+)/.exec(script);
  return match?.[1] ?? "vitest.config.ts";
}

/**
 * The config a script of the package at `dir` runs, as a path from the root
 * in the form of the listing (`/`-separated, `./` and `..` resolved), so
 * `--config ./vitest.int.config.ts` is the file the listing names.
 */
function configPathOf(dir: string, script: string): string {
  return posix.join(dir, configOfScript(script));
}

describe("intTestConfig", () => {
  const given: IntTestOptions[] = [
    { setupFiles: [], entryCheck: "postgres" },
    {
      setupFiles: ["@sf/config/vitest/setup"],
      entryCheck: "migrated-stack",
      testTimeout: 30_000,
    },
    {
      setupFiles: ["x"],
      entryCheck: "postgres",
      testTimeout: 1,
      hookTimeout: 1,
    },
    // Options the type does not have still cannot switch either back off.
    {
      setupFiles: ["x"],
      entryCheck: "migrated-stack",
      ...{ fileParallelism: true, globalSetup: [] },
    },
  ];

  it("runs integration files one at a time whatever it is given", () => {
    for (const options of given) {
      expect(intTestConfig(options).test?.fileParallelism).toBe(false);
    }
  });

  it("puts the entry check in front of the run whatever it is given", () => {
    // The guard of the test stack, once per run before the first file: no
    // file can reach another stack by forgetting a helper.
    for (const options of given) {
      expect(intTestConfig(options).test?.globalSetup).toEqual([
        entryCheckModule(options.entryCheck),
      ]);
    }
  });

  it("names entry checks every integration run resolves to their file", () => {
    // vitest resolves a `globalSetup` specifier from the root of the package
    // that runs; one it cannot resolve would be a path that does not exist.
    for (const dir of Object.keys(ENTRY_CHECK_OF)) {
      const resolve = createRequire(
        join(repoRoot, dir, "package.json"),
      ).resolve;
      for (const check of ENTRY_CHECKS) {
        const file = resolve(entryCheckModule(check));
        expect(relative(repoRoot, file).replaceAll("\\", "/"), dir).toBe(
          `packages/db/test-support/entry-check/${check}.ts`,
        );
      }
    }
  });

  it("collects integration files only", () => {
    const test = intTestConfig({ setupFiles: [], entryCheck: "postgres" }).test;
    expect(test?.include).toEqual(["**/*.int.test.ts"]);
  });

  it("passes the setup files and timeouts through as given", () => {
    const test = intTestConfig({
      setupFiles: ["@sf/config/vitest/setup"],
      entryCheck: "postgres",
      testTimeout: 15_000,
      hookTimeout: 12_000,
    }).test;
    expect(test?.setupFiles).toEqual(["@sf/config/vitest/setup"]);
    expect(test?.testTimeout).toBe(15_000);
    expect(test?.hookTimeout).toBe(12_000);
  });
});

describe("unitTestConfig", () => {
  it("keeps integration files out of pnpm test", () => {
    const test = unitTestConfig().test;
    expect(test?.exclude).toContain("**/*.int.test.ts");
    expect(test?.exclude).toContain("**/node_modules/**");
    expect(test?.include).toEqual(["test/**/*.test.ts", "src/**/*.test.ts"]);
  });

  it("looks in fewer directories only when asked", () => {
    const test = unitTestConfig({ testDirs: ["test"] }).test;
    expect(test?.include).toEqual(["test/**/*.test.ts"]);
    expect(test?.exclude).toContain("**/*.int.test.ts");
  });

  it("adds setup files only when asked", () => {
    expect(unitTestConfig().test?.setupFiles).toBeUndefined();
    expect(
      unitTestConfig({ setupFiles: ["@sf/config/vitest/setup"] }).test
        ?.setupFiles,
    ).toEqual(["@sf/config/vitest/setup"]);
  });
});

describe("configPathOf", () => {
  it.each([
    ["vitest run", "apps/api/vitest.config.ts"],
    [
      "vitest run --config vitest.int.config.ts",
      "apps/api/vitest.int.config.ts",
    ],
    [
      "vitest run --config ./vitest.int.config.ts",
      "apps/api/vitest.int.config.ts",
    ],
    [
      "vitest run --config=../api/vitest.int.config.ts",
      "apps/api/vitest.int.config.ts",
    ],
  ])("takes %s of apps/api for %s", (script, path) => {
    expect(configPathOf("apps/api", script)).toBe(path);
  });
});

describe("package vitest configs", () => {
  // Read in each case rather than when the file is collected: a git that
  // cannot list the tree is then a red case with its reason.
  const packageDirs = (): string[] => repoWorkspaceDirs();

  it("finds the packages of the workspace", () => {
    expect(packageDirs().length).toBeGreaterThanOrEqual(9);
  });

  it("every config a test script runs exists", () => {
    const missing: string[] = [];
    for (const dir of packageDirs()) {
      const scripts = scriptsOf(dir);
      for (const name of ["test", "test:int"]) {
        const script = scripts[name];
        if (script === undefined) {
          continue;
        }
        expect(script, `${dir} ${name}`).toMatch(/^vitest run\b/);
        const config = configPathOf(dir, script);
        if (!repoFileExists(config)) {
          missing.push(config);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every vitest config is a thin call into the preset", () => {
    const configs = packageDirs().flatMap((dir) => configsOf(dir));
    expect(configs.length).toBeGreaterThanOrEqual(12);

    const copies: string[] = [];
    for (const name of configs) {
      const source = readRepoFile(name);
      if (!PRESET_IMPORT.test(source)) {
        copies.push(`${name}: does not import vitest.preset`);
      }
      for (const key of PRESET_KEYS) {
        if (setsKey(source, key)) {
          copies.push(`${name}: sets ${key}`);
        }
      }
    }
    expect(copies).toEqual([]);
  });

  it("an integration config calls intTestConfig, any other unitTestConfig", () => {
    // An integration run on unitTestConfig would run its files in parallel
    // and without the entry check.
    const wrong: string[] = [];
    for (const dir of packageDirs()) {
      for (const name of configsOf(dir)) {
        const source = readRepoFile(name);
        const [want, not] = /\.int\.config\./.test(name)
          ? ["intTestConfig(", "unitTestConfig("]
          : ["unitTestConfig(", "intTestConfig("];
        if (!source.includes(want) || source.includes(not)) {
          wrong.push(`${name}: does not call ${want.slice(0, -1)} alone`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The border of `intTestConfig` is a fact of the files (ADR-0011): a package
   * with a `*.int.test.ts` has an integration run on the preset, behind an
   * entry check of `ENTRY_CHECK_OF`, and a package without one has none. An
   * integration file nothing runs is a test that never fails; a run with no
   * files is a gate that checks nothing.
   */
  it("gives an integration run to exactly the packages with integration files", () => {
    const names = packageDirs();
    const withFiles = names.filter((name) =>
      repoFilesUnder(name).some((path) => path.endsWith(".int.test.ts")),
    );
    const withRun = names.filter(
      (name) => scriptsOf(name)["test:int"] !== undefined,
    );
    const checked = Object.keys(ENTRY_CHECK_OF).sort();

    expect(withFiles.sort()).toEqual(checked);
    expect(withRun.sort()).toEqual(checked);
  });

  it("every integration run is behind its entry check", async () => {
    // Read from the configs as vitest loads them, not from their text.
    const runs: string[] = [];
    for (const name of packageDirs()) {
      const script = scriptsOf(name)["test:int"];
      if (script === undefined) {
        continue;
      }
      runs.push(name);
      const check = ENTRY_CHECK_OF[name];
      expect(check, `${name} has no entry check of its own`).toBeDefined();
      const file = join(repoRoot, name, configOfScript(script));
      const { test } = LoadedConfigSchema.parse(
        await import(pathToFileURL(file).href),
      ).default;
      expect(test.globalSetup, name).toEqual([
        entryCheckModule(check ?? "postgres"),
      ]);
      expect(test.fileParallelism, name).toBe(false);
      // What the entry check loads itself, so it sees what the files see.
      expect(test.setupFiles, name).toEqual(["@sf/config/vitest/setup"]);
    }
    expect(runs.sort()).toEqual(Object.keys(ENTRY_CHECK_OF).sort());
  });
});

describe("the key check of the scan", () => {
  it("sees a key bare, quoted and in backticks, and not inside a longer name", () => {
    for (const key of PRESET_KEYS) {
      expect(setsKey(`{ ${key}: [] }`, key), key).toBe(true);
      expect(setsKey(`{ "${key}": [] }`, key), key).toBe(true);
      expect(setsKey(`{ '${key}': [] }`, key), key).toBe(true);
      expect(setsKey(`{\n  ${key} : []`, key), key).toBe(true);
      expect(setsKey(`{ my${key}: [] }`, key), key).toBe(false);
      expect(setsKey(`{ ${key}Extra: [] }`, key), key).toBe(false);
    }
  });

  it("sees the shorthand form of a key", () => {
    for (const key of PRESET_KEYS) {
      expect(setsKey(`{ test: { ${key} } }`, key), key).toBe(true);
      expect(setsKey(`{ a: 1, ${key}, b: 2 }`, key), key).toBe(true);
      expect(setsKey(`{\n  ${key},\n}`, key), key).toBe(true);
      expect(setsKey(`{ my${key}, b }`, key), key).toBe(false);
      expect(setsKey(`{ ${key}Extra }`, key), key).toBe(false);
    }
  });

  it("knows every name vitest loads a config under", () => {
    for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
      expect(CONFIG_FILE.test(`vitest.int.config.${ext}`), ext).toBe(true);
    }
    expect(CONFIG_FILE.test("vitest.preset.ts")).toBe(false);
  });
});

describe("apps/web vitest config", () => {
  it("collects the tests of test/ only", async () => {
    // A `*.test.ts` under apps/web/src is a Next module: run in node without
    // the setup of the web tests it would be red, or green by chance.
    const { default: config } = await import("../apps/web/vitest.config.js");
    expect(config.test?.include).toEqual(["test/**/*.test.ts"]);
  });
});
