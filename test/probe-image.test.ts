import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PackageManifest } from "../scripts/lib/manifest.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  CONTAINER_SCRIPT,
  CONTROL,
  type ImageCheck,
  PROBES,
  PROBE_TIMEOUT_MS,
  type ProbeRun,
  REMOVE_TIMEOUT_MS,
  RESOLVE_ONLY,
  ROOT_OF,
  STDERR_LINES,
  WORKSPACE_OF,
  checksOf,
  containerName,
  dockerArgs,
  dockerRun,
  imageTag,
  main,
  resultOf,
  spawnProbe,
  timedOut,
  workspaceChecks,
} from "../scripts/probe-image.mjs";
import { imagesOf } from "./dockerfile.js";
import { dropLink } from "./drop-link.js";
import { readRepoFile } from "./repo-files.js";

/**
 * The probe the `docker-build` job runs on every image
 * (`scripts/probe-image.mjs`). Its program runs under the node of this test
 * against a temporary directory that stands in for the root of an image's
 * layout, so nothing depends on how pnpm laid out the repository; `main` gets
 * that run in place of `docker run`, and a manifest table in place of the
 * repository.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-probe-image-"));
const scriptsLink = join(scratch, "scripts-link");
afterAll(() => {
  // The link goes first on its own: a recursive remove must never walk through
  // it into the real scripts/ directory. A failure to take it off throws here
  // and the remove below does not run.
  dropLink(scriptsLink);
  rmSync(scratch, { recursive: true, force: true });
});

/** A directory holding the given files (path -> contents). */
function fakeImage(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** A package that loads: a manifest with `main` and that file. */
function pkg(path: string, index = ""): Record<string, string> {
  return {
    [`${path}/package.json`]: JSON.stringify({ main: "index.js" }),
    [`${path}/index.js`]: index,
  };
}

/** A package with an ESM entry under the `import` condition only. */
function esmOnly(path: string): Record<string, string> {
  return {
    [`${path}/package.json`]: JSON.stringify({
      type: "module",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    }),
    [`${path}/index.js`]: "export const value = 1;\n",
  };
}

/** The manifest file of a workspace link. */
const link = (path: string) => ({ [`${path}/package.json`]: "{}" });

interface Run extends ProbeRun {
  stdout: string;
  stderr: string;
}

// NODE_PATH: pnpm sets it for its scripts, and resolution would find packages
// the stand-in root does not hold.
function runIn(dir: string, checks: ImageCheck[], control = CONTROL): Run {
  return spawnSync(
    process.execPath,
    ["-e", CONTAINER_SCRIPT, dir, JSON.stringify({ checks, control })],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_PATH: "" },
    },
  );
}

/** The result line of a run of the program, parsed. */
function resultIn(dir: string, checks: ImageCheck[]) {
  const run = runIn(dir, checks);
  expect(run.status, run.stderr).toBe(0);
  return resultOf(run.stdout);
}

/**
 * A workspace of three packages as the probe reads it: api links db, db
 * links config - the link the recursion must follow.
 */
const MANIFESTS: Record<string, PackageManifest> = {
  "apps/api": {
    name: "@sf/api",
    dependencies: { "@sf/db": "workspace:*", fastify: "^5.0.0" },
  },
  "packages/db": {
    name: "@sf/db",
    dependencies: { "@sf/config": "workspace:*", postgres: "^3.4.0" },
  },
  "packages/config": { name: "@sf/config", dependencies: { zod: "^3.0.0" } },
};
const read = (dir: string): PackageManifest => {
  const found = MANIFESTS[dir];
  if (found === undefined) throw new Error(`no manifest in ${dir}`);
  return found;
};
const dirs = () => Object.keys(MANIFESTS);

/** Everything the api of `MANIFESTS` needs, laid out as pnpm lays it out. */
const API_FILES = {
  ...pkg("apps/api/node_modules/tsx"),
  ...pkg("apps/api/node_modules/fastify"),
  ...link("apps/api/node_modules/@sf/db"),
  ...pkg("packages/db/node_modules/postgres"),
  ...link("packages/db/node_modules/@sf/config"),
  ...pkg("packages/config/node_modules/zod"),
};
const apiImage = fakeImage("api", API_FILES);

describe("image probe program", () => {
  const nested = fakeImage("nested", {
    "server.js": "",
    ...pkg("app/node_modules/present"),
    ...esmOnly("app/node_modules/esm-only"),
    ...pkg("app/node_modules/broken", "throw new Error('broken on load');"),
    "migrations/0000_init.sql": "select 1;",
    "empty/readme.md": "",
    "app/node_modules/subpaths-only/package.json": JSON.stringify({
      exports: { "./server": "./server.js" },
    }),
    "app/node_modules/subpaths-only/server.js": "throw new Error('loaded');",
    "app/node_modules/browser-only/package.json": JSON.stringify({
      exports: { ".": { browser: "./index.js" } },
    }),
  });

  it("passes for files and packages that are there, and fails the control in the same run", () => {
    expect(
      resultIn(nested, [
        { file: "server.js" },
        { pkg: "present", from: "app" },
        { files: "migrations", suffix: ".sql" },
      ]),
    ).toEqual({ missing: [], tests: [], control: "failed" });
  });

  it("reports a control check that did not fail", () => {
    const run = runIn(nested, [], { pkg: "present", from: "app" });

    expect(resultOf(run.stdout)).toEqual({
      missing: [],
      tests: [],
      control: "passed",
    });
  });

  it("loads a package that has an ESM entry under `import` only", () => {
    expect(resultIn(nested, [{ pkg: "esm-only", from: "app" }])).toEqual({
      missing: [],
      tests: [],
      control: "failed",
    });
  });

  it("names a package that resolves but throws when it loads", () => {
    const result = resultIn(nested, [{ pkg: "broken", from: "app" }]);

    expect(result?.missing).toEqual([
      expect.stringMatching(/^broken \(from app\): broken on load$/),
    ]);
  });

  it("checks only the entry file of a package that must not be loaded", () => {
    expect(
      resultIn(nested, [{ pkg: "broken", from: "app", resolveOnly: true }]),
    ).toEqual({ missing: [], tests: [], control: "failed" });
  });

  it("names a file that is not there, and a directory without the files", () => {
    const result = resultIn(nested, [
      { file: "apps/web/server.js" },
      { files: "empty", suffix: ".sql" },
    ]);

    expect(result?.missing).toEqual([
      expect.stringContaining("apps/web/server.js"),
      expect.stringContaining("empty: no file ending in .sql"),
    ]);
  });

  it("finds a package from the directory given and its parents, not from elsewhere", () => {
    expect(resultIn(nested, [{ pkg: "present", from: "." }])?.missing).toEqual([
      expect.stringContaining("present (from .): not installed"),
    ]);
    expect(
      resultIn(nested, [{ pkg: "present", from: "app/src" }])?.missing,
    ).toEqual([]);
  });

  it("passes a package whose exports have no root entry by its package.json", () => {
    expect(
      resultIn(nested, [{ pkg: "subpaths-only", from: "app" }])?.missing,
    ).toEqual([]);
  });

  it("still names a package whose root entry has no condition it loads by", () => {
    expect(
      resultIn(nested, [{ pkg: "browser-only", from: "app" }])?.missing,
    ).toEqual(["browser-only (from app): no entry for node, import, default"]);
  });

  it("looks for a package from the root of the layout when no directory is given", () => {
    const flat = fakeImage("flat", pkg("node_modules/flat"));

    expect(resultIn(flat, [{ pkg: "flat" }])).toEqual({
      missing: [],
      tests: [],
      control: "failed",
    });
  });

  it("names the tests a package directory carries, as their own result", () => {
    const tested = fakeImage("tested", {
      "apps/api/src/server.ts": "",
      "apps/api/src/routes/health.test.ts": "",
      "apps/api/test/fixture.ts": "",
      "packages/db/test-support/db.ts": "",
      "packages/db/vitest.int.config.ts": "",
      "packages/db/src/schema.ts": "",
      "packages/config/vitest/setup.ts": "",
      ...pkg("apps/api/node_modules/dep/test"),
    });

    expect(
      resultIn(tested, [
        { noTests: "apps/api" },
        { noTests: "packages/db" },
        { noTests: "packages/config" },
      ]),
    ).toEqual({
      missing: [],
      tests: [
        "apps/api/src/routes/health.test.ts",
        "apps/api/test",
        "packages/db/test-support",
        "packages/db/vitest.int.config.ts",
      ],
      control: "failed",
    });
  });

  it("passes a package directory the image does not have", () => {
    expect(resultIn(nested, [{ noTests: "packages/gone" }])).toEqual({
      missing: [],
      tests: [],
      control: "failed",
    });
  });

  it("prints its result as the last line, after what a package printed", () => {
    const noisy = fakeImage("noisy", {
      ...pkg("node_modules/noisy", "console.log('hello from a package');"),
    });
    const run = runIn(noisy, [{ pkg: "noisy", from: "." }]);

    expect(run.stdout).toContain("hello from a package");
    expect(resultOf(run.stdout)).toEqual({
      missing: [],
      tests: [],
      control: "failed",
    });
  });
});

describe("image probe table", () => {
  it("has checks and a root for every image the repository builds, and for no other", () => {
    expect(Object.keys(PROBES).sort()).toEqual(imagesOf());
    expect(Object.keys(ROOT_OF).sort()).toEqual(imagesOf());
  });

  it("checks the workspace packages of the services that run from their package", () => {
    expect(Object.keys(WORKSPACE_OF).sort()).toEqual(
      imagesOf().filter((image) => image !== "web"),
    );
  });

  it("checks the migrations and their journal in the migrate image", () => {
    expect(checksOf("migrate")).toEqual(
      expect.arrayContaining([
        { files: "packages/db/migrations", suffix: ".sql" },
        { file: "packages/db/migrations/meta/_journal.json" },
        { pkg: "postgres", from: "packages/db" },
      ]),
    );
  });

  /** A manifest for every directory, with no dependencies where MANIFESTS has none. */
  const bare = (dir: string): PackageManifest =>
    MANIFESTS[dir] ?? { name: `@sf/${dir}`, dependencies: {} };

  it.each(Object.entries(WORKSPACE_OF))(
    "loads tsx in the %s image from %s, whatever its manifest says",
    (image, dir) => {
      expect(checksOf(image, bare, dirs)).toContainEqual({
        pkg: "tsx",
        from: dir,
      });
    },
  );

  /** A manifest with no dependencies for every directory. */
  const none = (dir: string): PackageManifest => ({
    name: `@sf/${dir}`,
    dependencies: {},
  });

  it.each([
    ["fastify", "api", "apps/api"],
    ["bullmq", "worker", "apps/worker"],
    ["drizzle-orm", "migrate", "packages/db"],
  ])(
    "loads %s in the %s image whatever its manifest says",
    (name, image, dir) => {
      expect(checksOf(image, none, dirs)).toContainEqual({
        pkg: name,
        from: dir,
      });
    },
  );

  it.each(Object.keys(PROBES))(
    "checks every package directory of the workspace for tests in the %s image",
    (image) => {
      expect(
        checksOf(image, bare, dirs).filter(
          (check) => check.noTests !== undefined,
        ),
      ).toEqual(dirs().map((dir) => ({ noTests: dir })));
    },
  );

  it.each(Object.keys(PROBES))(
    "lists the workspace once for the checks of the %s image",
    (image) => {
      let calls = 0;
      const counted = () => {
        calls += 1;
        return dirs();
      };

      checksOf(image, bare, counted);

      expect(calls).toBe(1);
    },
  );

  it("takes the directory tsx loads from out of WORKSPACE_OF alone", () => {
    for (const checks of Object.values(PROBES)) {
      expect(checks.filter((check) => check.pkg === "tsx")).toEqual([]);
    }
  });

  it("checks tsx once when the manifest names it as well", () => {
    const withTsx = (dir: string): PackageManifest =>
      dir === "apps/api"
        ? {
            name: "@sf/api",
            dependencies: { "@sf/db": "workspace:*", tsx: "^4.19.0" },
          }
        : read(dir);

    expect(
      checksOf("api", withTsx, dirs).filter((check) => check.pkg === "tsx"),
    ).toEqual([{ pkg: "tsx", from: "apps/api" }]);
  });

  it("follows the workspace links of the packages a service links", () => {
    expect(workspaceChecks("apps/api", read, dirs)).toEqual([
      { pkg: "fastify", from: "apps/api" },
      { file: "apps/api/node_modules/@sf/db/package.json" },
      { pkg: "zod", from: "packages/config" },
      { file: "packages/db/node_modules/@sf/config/package.json" },
      { pkg: "postgres", from: "packages/db" },
    ]);
  });

  it("checks the packages of RESOLVE_ONLY for their entry, each with its reason", () => {
    const only = (dir: string): PackageManifest =>
      dir === "apps/api"
        ? { name: "@sf/api", dependencies: { "server-only": "^0.0.1" } }
        : read(dir);

    expect(workspaceChecks("apps/api", only, dirs)).toEqual([
      { pkg: "server-only", from: "apps/api", resolveOnly: true },
    ]);
    for (const reason of Object.values(RESOLVE_ONLY)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses a link to a package no workspace dir holds", () => {
    const lost = (dir: string): PackageManifest =>
      dir === "apps/api"
        ? { name: "@sf/api", dependencies: { "@sf/gone": "workspace:*" } }
        : read(dir);

    expect(() => workspaceChecks("apps/api", lost, dirs)).toThrow(
      "apps/api links @sf/gone, which no workspace dir holds",
    );
  });
});

describe("image probe docker run", () => {
  it("runs the image just built, offline, under a name, and never pulls one from a registry", () => {
    const args = dockerArgs("sf-api:ci", "/repo", [], "sf-probe-1-ab");

    expect(args.slice(0, 7)).toEqual([
      "run",
      "--rm",
      "--name",
      "sf-probe-1-ab",
      "--pull=never",
      "--network",
      "none",
    ]);
    expect(args).toContain("sf-api:ci");
    expect(args.slice(-2, -1)).toEqual(["/repo"]);
  });

  it("names each run's container apart, by a name docker takes", () => {
    const names = [containerName(), containerName()];

    expect(names[0]).not.toBe(names[1]);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    }
  });

  it("tags the image the way CI builds it", () => {
    expect(imageTag("api")).toBe("sf-api:ci");
  });

  /** A spawn that answers each call in turn, recording what it was given. */
  function spawnOf(...answers: ProbeRun[]) {
    let call = 0;
    return vi.fn(
      (_command: string, _args: string[], _timeoutMs: number): ProbeRun => {
        const answer = answers[call] ?? { status: 0, stderr: "" };
        call += 1;
        return answer;
      },
    );
  }
  const TIMED_OUT: ProbeRun = {
    status: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  };

  it("runs docker under the time limit of the probe, in the container it names", () => {
    const spawn = spawnOf({ status: 0, stdout: "x", stderr: "" });

    const run = dockerRun("sf-api:ci", "/repo", [], spawn, "sf-probe-1-ab");

    expect(run).toEqual({ status: 0, stdout: "x", stderr: "" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toEqual([
      "docker",
      dockerArgs("sf-api:ci", "/repo", [], "sf-probe-1-ab"),
      PROBE_TIMEOUT_MS,
    ]);
  });

  it("removes the container of a run that did not finish in time, and says so", () => {
    const spawn = spawnOf(TIMED_OUT, { status: 0, stderr: "" });

    const run = dockerRun("sf-api:ci", "/repo", [], spawn, "sf-probe-1-ab");

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]).toEqual([
      "docker",
      ["rm", "-f", "sf-probe-1-ab"],
      REMOVE_TIMEOUT_MS,
    ]);
    expect(timedOut(run)).toBe(true);
    expect(run.cleanup).toBe("container sf-probe-1-ab is gone (docker rm -f)");
  });

  it("says that the container may still run when docker rm -f fails", () => {
    const spawn = spawnOf(TIMED_OUT, {
      status: 1,
      stderr: "Error response from daemon: cannot remove",
    });

    const run = dockerRun("sf-api:ci", "/repo", [], spawn, "sf-probe-1-ab");

    expect(run.cleanup).toBe(
      "container sf-probe-1-ab may still be running, docker rm -f failed: Error response from daemon: cannot remove",
    );
  });
});

describe("image probe time limit", () => {
  /**
   * The run below would end by itself after `LIVES_MS`: a limit that does
   * not work makes the test red after that long, not hang it. The bound of
   * the check sits between the limit given and that life.
   */
  const LIMIT_MS = 500;
  const LIVES_MS = 8000;

  it("kills a run that does not finish in time", () => {
    const started = Date.now();
    const run = spawnProbe(
      process.execPath,
      ["-e", `setTimeout(() => {}, ${LIVES_MS})`],
      LIMIT_MS,
    );

    expect(timedOut(run)).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(LIVES_MS / 2);
  });

  it("leaves a run that finished in time as it is", () => {
    const run = spawnProbe(process.execPath, [
      "-e",
      "process.stdout.write('x')",
    ]);

    expect(timedOut(run)).toBe(false);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("x");
  });

  it("gives a run the limit of the probe unless told otherwise", () => {
    const spawn = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: { encoding: "utf8"; timeout: number; killSignal: "SIGKILL" },
      ): ProbeRun => ({ status: 0, stderr: "" }),
    );

    spawnProbe("docker", ["version"], undefined, spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]).toEqual({
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  });

  it("ends a probe and the removal of its container well before the CI job ends", () => {
    const job =
      /\n {2}docker-build:\n(?: {4}.*\n)*? {4}timeout-minutes: (\d+)\n/.exec(
        readRepoFile(".github/workflows/ci.yml").replace(/\r\n/g, "\n"),
      )?.[1];

    expect(job).toBeDefined();
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS + REMOVE_TIMEOUT_MS).toBeLessThan(
      (Number(job) * 60_000) / 4,
    );
  });
});

describe("image probe result", () => {
  it.each([
    ["an empty stdout", ""],
    ["noise only", "hello\n"],
    ["JSON of another shape", '{"missing":"x","control":"failed"}\n'],
    ["an unknown control", '{"missing":[],"tests":[],"control":"red"}\n'],
    ["JSON without the tests", '{"missing":[],"control":"failed"}\n'],
    [
      "tests that are not strings",
      '{"missing":[],"tests":[1],"control":"failed"}\n',
    ],
    ["JSON that is not an object", "[]\n"],
  ])("has no result in %s", (_, stdout) => {
    expect(resultOf(stdout)).toBeNull();
  });
});

describe("image probe main", () => {
  const lines: string[] = [];
  type RunOf = (tag: string, root: string, checks: ImageCheck[]) => ProbeRun;
  const deps = (run: RunOf) => ({
    run,
    read,
    dirs,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  });
  const inDir = (dir: string) =>
    vi.fn((_tag: string, _root: string, checks: ImageCheck[]) =>
      runIn(dir, checks),
    );
  const printed = (stdout: string) =>
    vi.fn((): ProbeRun => ({ status: 0, stdout, stderr: "" }));

  it("passes an image that has everything, in one run whose control fails", () => {
    const run = inDir(apiImage);
    lines.length = 0;

    expect(main(["api", "sf-api:test"], deps(run))).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["sf-api:test", "/repo"]);
    expect(lines.join("\n")).toContain(
      "sf-api:test ok (9 checks, control red)",
    );
  });

  it("fails an image without a link of a package its service reaches through another", () => {
    const { "packages/db/node_modules/@sf/config/package.json": _, ...rest } =
      API_FILES;
    const unlinked = fakeImage("unlinked", rest);
    lines.length = 0;

    expect(main(["api"], deps(inDir(unlinked)))).toBe(1);
    expect(lines.join("\n")).toContain(
      "missing packages/db/node_modules/@sf/config/package.json",
    );
  });

  it.each([
    [
      "the postgres driver",
      "packages/db/node_modules/postgres/index.js",
      "postgres (from packages/db): no main file",
    ],
    [
      "the SQL of the migrations",
      "packages/db/migrations/0000_init.sql",
      "packages/db/migrations: no file ending in .sql",
    ],
    [
      "the journal",
      "packages/db/migrations/meta/_journal.json",
      "packages/db/migrations/meta/_journal.json: ENOENT",
    ],
  ])("fails a migrate image without %s", (_, path, missing) => {
    const files: Record<string, string> = {
      ...pkg("packages/db/node_modules/tsx"),
      ...pkg("packages/db/node_modules/postgres"),
      ...pkg("packages/db/node_modules/drizzle-orm"),
      ...link("packages/db/node_modules/@sf/config"),
      ...pkg("packages/config/node_modules/zod"),
      "packages/db/migrations/0000_init.sql": "select 1;",
      "packages/db/migrations/meta/_journal.json": "{}",
    };
    delete files[path];
    const image = fakeImage(`migrate-${path.replaceAll("/", "-")}`, files);
    const migrateRead = (dir: string): PackageManifest => read(dir);
    lines.length = 0;

    expect(
      main(["migrate"], { ...deps(inDir(image)), read: migrateRead }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("is missing what it starts from");
    expect(lines.join("\n")).toContain(missing);
  });

  it("fails an api image without tsx, which its manifest does not name", () => {
    const { "apps/api/node_modules/tsx/index.js": _, ...rest } = API_FILES;
    const noTsx = fakeImage("no-tsx", rest);
    lines.length = 0;

    expect(main(["api"], deps(inDir(noTsx)))).toBe(1);
    expect(lines.join("\n")).toContain("tsx (from apps/api): no main file");
  });

  it("fails an api image without fastify, which its manifest does not name", () => {
    const { "apps/api/node_modules/fastify/index.js": _, ...rest } = API_FILES;
    const noFastify = fakeImage("no-fastify", rest);
    const unnamed = (dir: string): PackageManifest =>
      dir === "apps/api"
        ? { name: "@sf/api", dependencies: { "@sf/db": "workspace:*" } }
        : read(dir);
    lines.length = 0;

    expect(main(["api"], { ...deps(inDir(noFastify)), read: unnamed })).toBe(1);
    expect(lines.join("\n")).toContain("fastify (from apps/api): no main file");
  });

  it("refuses a run that did not finish in time, naming the limit, its container and what it printed", () => {
    const killed = (): ProbeRun => ({
      status: null,
      signal: "SIGKILL",
      stdout: "loading packages\n",
      stderr: "(node:1) Warning: slow import\n",
      error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
      cleanup: "container sf-probe-1-ab is gone (docker rm -f)",
    });
    lines.length = 0;

    expect(main(["api"], deps(killed))).toBe(2);
    expect(lines).toEqual([
      `probe-image: the probe in sf-api:ci did not finish in ${PROBE_TIMEOUT_MS / 1000} s`,
      "probe-image: container sf-probe-1-ab is gone (docker rm -f)",
      "probe-image: stdout of the run so far:",
      "loading packages",
      "probe-image: stderr of the run so far:",
      "(node:1) Warning: slow import",
    ]);
  });

  it("fails an image that carries tests, apart from what it lacks", () => {
    lines.length = 0;

    expect(
      main(
        ["api"],
        deps(
          printed(
            '{"missing":[],"tests":["apps/api/test"],"control":"failed"}',
          ),
        ),
      ),
    ).toBe(1);
    expect(lines).toEqual([
      "probe-image: sf-api:ci carries the tests of its packages",
      "probe-image: tests apps/api/test",
    ]);
  });

  it("reports what an image lacks and the tests it carries in one run", () => {
    lines.length = 0;

    expect(
      main(
        ["api"],
        deps(
          printed(
            '{"missing":["tsx (from apps/api): not installed"],"tests":["apps/api/test"],"control":"failed"}',
          ),
        ),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("missing tsx (from apps/api)");
    expect(lines.join("\n")).toContain("tests apps/api/test");
  });

  it("fails an image whose package directory holds a test, through the program", () => {
    const tested = fakeImage("api-tested", {
      ...API_FILES,
      "packages/db/src/client.test.ts": "",
    });
    lines.length = 0;

    expect(main(["api"], deps(inDir(tested)))).toBe(1);
    expect(lines.join("\n")).toContain("tests packages/db/src/client.test.ts");
  });

  it("fails when the control check does not turn red", () => {
    lines.length = 0;

    expect(
      main(
        ["api"],
        deps(printed('{"missing":[],"tests":[],"control":"passed"}')),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("the control check did not fail");
  });

  it.each([
    ["nothing", ""],
    ["JSON of another shape", '{"missing":[]}'],
  ])("refuses a run that exited with 0 and printed %s", (_, stdout) => {
    lines.length = 0;

    expect(main(["api"], deps(printed(stdout)))).toBe(2);
    expect(lines.join("\n")).toContain("probe printed no result in sf-api:ci");
  });

  it("tells a docker failure from a missing package", () => {
    const noDocker = (): ProbeRun => ({
      status: 125,
      stderr: "Unable to find image 'sf-api:ci' locally",
    });
    lines.length = 0;

    expect(main(["api"], deps(noDocker))).toBe(2);
    expect(lines.join("\n")).toContain("could not run the probe in sf-api:ci");
  });

  it("prints the first lines of a long stderr and says how many were cut", () => {
    const stderr = Array.from(
      { length: STDERR_LINES + 5 },
      (_, at) => `l${at}`,
    );
    lines.length = 0;

    expect(
      main(
        ["api"],
        deps(() => ({ status: 1, stderr: stderr.join("\n") })),
      ),
    ).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain(`l${STDERR_LINES - 1}`);
    expect(text).not.toContain(`l${STDERR_LINES}\n`);
    expect(text).toContain("... (5 more lines of stderr cut)");
  });

  it("tells a manifest that cannot be read from a missing package", () => {
    const run = vi.fn((): ProbeRun => ({ status: 0, stderr: "" }));
    lines.length = 0;

    expect(
      main(["api"], {
        ...deps(run),
        read: () => {
          throw new Error("ENOENT: no such file");
        },
      }),
    ).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("could not work out the checks of api");
    expect(lines.join("\n")).toContain("ENOENT");
  });

  it("reports status and signal when docker prints nothing", () => {
    const killed = (): ProbeRun => ({
      status: null,
      stderr: "",
      signal: "SIGKILL",
    });
    lines.length = 0;

    expect(main(["api"], deps(killed))).toBe(2);
    expect(lines.join("\n")).toContain("signal SIGKILL");
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("refuses an unknown image, including names of Object.prototype, without docker", () => {
    for (const image of ["nginx", "constructor", "toString"]) {
      const run = inDir(apiImage);
      lines.length = 0;
      expect(main([image], deps(run))).toBe(2);
      expect(run).toHaveBeenCalledTimes(0);
      expect(lines.join("\n")).toContain(`unknown image "${image}"`);
    }
  });

  it("refuses a tag that docker would read as a flag", () => {
    const run = inDir(apiImage);
    lines.length = 0;

    expect(main(["api", "--privileged"], deps(run))).toBe(2);
    expect(run).toHaveBeenCalledTimes(0);
    expect(lines.join("\n")).toContain('"--privileged" is not an image tag');
  });
});

describe("image probe entry guard", () => {
  const script = join(repoRoot, "scripts", "probe-image.mjs");

  it("runs main when started by its own path, as CI starts it", () => {
    const result = spawnSync(process.execPath, [script, "no-such-image"], {
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.stderr).toContain('unknown image "no-such-image"');
    expect(result.status).toBe(2);
  });

  it("runs main when started through a link to the script's directory", () => {
    symlinkSync(resolve(script, ".."), scriptsLink, "junction");

    const result = spawnSync(
      process.execPath,
      [join(scriptsLink, "probe-image.mjs"), "no-such-image"],
      { encoding: "utf8", timeout: 20_000 },
    );

    expect(result.stderr).toContain('unknown image "no-such-image"');
    expect(result.status).toBe(2);
  });

  /**
   * The exit code is set, not forced: `process.exit()` would end the script
   * before a `finally` or a pending write ran. No spawn tells the two apart -
   * main is synchronous and leaves nothing pending - so this is a lock on the
   * text of the script.
   */
  it("sets the exit code instead of calling process.exit", () => {
    const text = readRepoFile("scripts/probe-image.mjs");
    const outside = text.replace(
      /export const CONTAINER_SCRIPT = `[^`]*`;/,
      "",
    );

    expect(outside).not.toBe(text);

    expect(outside).toContain("process.exitCode = main(");
    expect(outside).not.toContain("process.exit(");
  });
});
