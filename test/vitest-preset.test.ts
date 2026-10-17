import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type EntryCheck,
  type IntTestOptions,
  entryCheckModule,
  intTestConfig,
  unitTestConfig,
} from "../vitest.preset.js";

/**
 * The preset is the one place the test policy of the workspace is written
 * down (docs/adr/0011-vitest-preset-and-test-support.md). What this file
 * guards is that it stays the one place: a package config that sets its own
 * `include` or forgets the preset is a copy again, and the integration runs
 * are only safe while their files run one at a time.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
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

function readRootJson(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
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

/**
 * Package directories of the workspace, from the globs of
 * `pnpm-workspace.yaml` (only the `dir/*` form it uses is understood; any
 * other form fails the test instead of being skipped).
 */
function workspacePackageDirs(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = Array.from(yaml.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm))
    .map((match) => match[1])
    .filter((glob): glob is string => glob !== undefined);
  expect(globs.length).toBeGreaterThan(0);
  const dirs: string[] = [];
  for (const glob of globs) {
    expect(glob, `workspace glob "${glob}"`).toMatch(/^[\w/-]+\/\*$/);
    const parent = join(ROOT, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dir = join(parent, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, "package.json"))) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
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
      const resolve = createRequire(join(ROOT, dir, "package.json")).resolve;
      for (const check of ENTRY_CHECKS) {
        const file = resolve(entryCheckModule(check));
        expect(relative(ROOT, file).replaceAll("\\", "/"), dir).toBe(
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
  const dirs = workspacePackageDirs();

  it("finds the packages of the workspace", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(9);
  });

  it("every config a test script runs exists", () => {
    const missing: string[] = [];
    for (const dir of dirs) {
      const scripts = scriptsOf(
        readRootJson(relative(ROOT, join(dir, "package.json"))),
      );
      for (const name of ["test", "test:int"]) {
        const script = scripts[name];
        if (script === undefined) {
          continue;
        }
        expect(script, `${relative(ROOT, dir)} ${name}`).toMatch(
          /^vitest run\b/,
        );
        const config = join(dir, configOfScript(script));
        if (!existsSync(config)) {
          missing.push(relative(ROOT, config));
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every vitest config is a thin call into the preset", () => {
    const configs = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => CONFIG_FILE.test(file))
        .map((file) => join(dir, file)),
    );
    expect(configs.length).toBeGreaterThanOrEqual(12);

    const copies: string[] = [];
    for (const config of configs) {
      const source = readFileSync(config, "utf8");
      const name = relative(ROOT, config).replaceAll("\\", "/");
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
      for (const file of readdirSync(dir).filter((f) => CONFIG_FILE.test(f))) {
        const source = readFileSync(join(dir, file), "utf8");
        const name = relative(ROOT, join(dir, file)).replaceAll("\\", "/");
        const [want, not] = /\.int\.config\./.test(file)
          ? ["intTestConfig(", "unitTestConfig("]
          : ["unitTestConfig(", "intTestConfig("];
        if (!source.includes(want) || source.includes(not)) {
          wrong.push(`${name}: does not call ${want.slice(0, -1)} alone`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every integration run is behind its entry check", async () => {
    // Read from the configs as vitest loads them, not from their text.
    const runs: string[] = [];
    for (const dir of dirs) {
      const script = scriptsOf(
        readRootJson(relative(ROOT, join(dir, "package.json"))),
      )["test:int"];
      if (script === undefined) {
        continue;
      }
      const name = relative(ROOT, dir).replaceAll("\\", "/");
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

describe("root test:int script", () => {
  it("runs the integration packages one at a time", () => {
    // Files of one package are serialised by the preset; packages share the
    // same test database and Redis, and this flag is what serialises them.
    const script = scriptsOf(readRootJson("package.json"))["test:int"];
    expect(script).toMatch(/^turbo run test:int\b/);
    expect(script).toMatch(/(?:^|\s)--concurrency=1(?:\s|$)/);
  });
});
