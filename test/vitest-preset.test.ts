import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { workspaceDirs } from "../scripts/lib/manifest.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  type EntryCheck,
  type IntTestOptions,
  entryCheckModule,
  intTestConfig,
  unitTestConfig,
} from "../vitest.preset.js";
import { readRepoFile, readRepoJson, repoFilesUnder } from "./repo-files.js";

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
 * The vitest configs at the top of the package at `dir` (absolute), as paths
 * from the root, among the files the hash covers (`repoFilesUnder`): an
 * ignored one is in no hash, and what it holds must not change a result.
 */
function configsOf(dir: string): string[] {
  const from = relative(repoRoot, dir).replaceAll("\\", "/");
  return repoFilesUnder(from).filter((path) => {
    const name = path.slice(from.length + 1);
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

/** A property of a value of unknown shape; `undefined` when it has none. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function scriptsOf(manifest: unknown): Record<string, string> {
  if (typeof manifest !== "object" || manifest === null) {
    return {};
  }
  const scripts: unknown = Reflect.get(manifest, "scripts");
  if (typeof scripts !== "object" || scripts === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** The config file a `vitest run` script reads (`--config <file>` or the default). */
function configOfScript(script: string): string {
  const match = /(?:^|\s)--config(?:=|\s+)(\S+)/.exec(script);
  return match?.[1] ?? "vitest.config.ts";
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

describe("package vitest configs", () => {
  const dirs = workspaceDirs().map((dir) => join(repoRoot, dir));

  it("finds the packages of the workspace", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(9);
  });

  it("every config a test script runs exists", () => {
    const missing: string[] = [];
    for (const dir of dirs) {
      const scripts = scriptsOf(
        readRepoJson(relative(repoRoot, join(dir, "package.json"))),
      );
      for (const name of ["test", "test:int"]) {
        const script = scripts[name];
        if (script === undefined) {
          continue;
        }
        expect(script, `${relative(repoRoot, dir)} ${name}`).toMatch(
          /^vitest run\b/,
        );
        const config = join(dir, configOfScript(script));
        if (!existsSync(config)) {
          missing.push(relative(repoRoot, config));
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every vitest config is a thin call into the preset", () => {
    const configs = dirs.flatMap((dir) =>
      configsOf(dir).map((name) => join(repoRoot, name)),
    );
    expect(configs.length).toBeGreaterThanOrEqual(12);

    const copies: string[] = [];
    for (const config of configs) {
      const name = relative(repoRoot, config).replaceAll("\\", "/");
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
    for (const dir of dirs) {
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
    const names = dirs.map((dir) =>
      relative(repoRoot, dir).replaceAll("\\", "/"),
    );
    const withFiles = names.filter((name) =>
      repoFilesUnder(name).some((path) => path.endsWith(".int.test.ts")),
    );
    const withRun = names.filter(
      (name) =>
        scriptsOf(readRepoJson(`${name}/package.json`))["test:int"] !==
        undefined,
    );
    const checked = Object.keys(ENTRY_CHECK_OF).sort();

    expect(withFiles.sort()).toEqual(checked);
    expect(withRun.sort()).toEqual(checked);
  });

  it("every integration run is behind its entry check", async () => {
    // Read from the configs as vitest loads them, not from their text.
    const runs: string[] = [];
    for (const dir of dirs) {
      const script = scriptsOf(
        readRepoJson(relative(repoRoot, join(dir, "package.json"))),
      )["test:int"];
      if (script === undefined) {
        continue;
      }
      const name = relative(repoRoot, dir).replaceAll("\\", "/");
      runs.push(name);
      const check = ENTRY_CHECK_OF[name];
      expect(check, `${name} has no entry check of its own`).toBeDefined();
      const file = join(dir, configOfScript(script));
      const loaded: unknown = await import(pathToFileURL(file).href);
      const test = fieldOf(fieldOf(loaded, "default"), "test");
      expect(fieldOf(test, "globalSetup"), name).toEqual([
        entryCheckModule(check ?? "postgres"),
      ]);
      expect(fieldOf(test, "fileParallelism"), name).toBe(false);
      // What the entry check loads itself, so it sees what the files see.
      expect(fieldOf(test, "setupFiles"), name).toEqual([
        "@sf/config/vitest/setup",
      ]);
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
