#!/usr/bin/env node
/**
 * Gate: an image whose install put nothing in place must not pass.
 *
 * `node scripts/probe-image.mjs <image> [tag]` runs the built image (tag
 * defaults to `imageTag(image)`, the tag CI builds) once, without a network,
 * and checks from the root of its layout that what the service starts from
 * is there: `tsx` for the images that run through it, the files of `PROBES`,
 * every external package of the manifest of the service's package and of
 * each workspace package (`@sf/*`) it reaches through `workspace:` links -
 * loaded, not only resolved - and every such link. It also checks that the
 * package directories of the image carry no tests (`TEST_NAMES`): the
 * `.dockerignore` masks keep them out, and this sees what reached the image.
 * In the same run it checks one package that cannot exist and requires that
 * check to fail: a probe that cannot turn red proves nothing. The program in
 * the image prints its result as one line of JSON.
 *
 * Exit 1: the image lacks something, carries tests, or the control check
 * did not fail. Exit 2: the probe could not run (unknown image, a tag that
 * reads as a flag, docker itself failing, a manifest that cannot be read, a
 * run that printed no result or did not finish in `PROBE_TIMEOUT_MS` - its
 * container is then removed by name) - nothing is known about the image.
 *
 * Used by the `docker-build` job of .github/workflows/ci.yml, one image per
 * matrix element, so all four images are probed the same way.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readManifestFields, workspaceDirs } from "./lib/manifest.mjs";
import { isEntry } from "./lib/paths.mjs";

/**
 * @typedef {import("./lib/manifest.mjs").PackageManifest} PackageManifest
 */

/**
 * One check inside an image, paths from the root of its layout: `file` must
 * be a file; `files` a directory holding at least one file ending in
 * `suffix`; `pkg` a package that loads (`import()` of its entry) from the
 * directory `from` (the root of the layout when it is not given) - or, with
 * `resolveOnly`, whose entry file is there. A package whose `exports` has no
 * root entry (`"."`) has nothing to load by its name: its `package.json`
 * being there is the check. `noTests` is a package directory that must hold
 * no entry named by `TEST_NAMES` at any depth outside `node_modules`; a
 * directory the image does not have passes (web keeps only what its build
 * traced).
 *
 * @typedef {object} ImageCheck
 * @property {string} [file]
 * @property {string} [files]
 * @property {string} [suffix]
 * @property {string} [pkg]
 * @property {string} [from]
 * @property {boolean} [resolveOnly]
 * @property {string} [noTests]
 */

/**
 * What one probe run returned, as `spawnSync` reports it, and - after a run
 * that did not finish in time - what became of its container.
 *
 * @typedef {object} ProbeRun
 * @property {number | null} status
 * @property {string | null} [stdout]
 * @property {string | null} stderr
 * @property {string | null} [signal]
 * @property {Error} [error]
 * @property {string} [cleanup]
 */

/**
 * How the probe starts a process: `spawnSync` by default.
 *
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options: { encoding: "utf8", timeout: number, killSignal: "SIGKILL" },
 * ) => ProbeRun} SpawnSync
 */

/**
 * How `dockerRun` runs docker: `spawnProbe` by default.
 *
 * @typedef {(command: string, args: string[], timeoutMs: number) => ProbeRun} Spawn
 */

/**
 * The line the program in the image prints: what is missing, the test files
 * it found, and whether the control check failed as it must.
 *
 * @typedef {object} ProbeResult
 * @property {string[]} missing
 * @property {string[]} tests
 * @property {"failed" | "passed"} control
 */

/**
 * What `main` works with; each has a default that reaches docker, the
 * repository and the console.
 *
 * @typedef {object} ProbeDeps
 * @property {(tag: string, root: string, checks: ImageCheck[]) => ProbeRun} [run]
 *   runs the check list against an image tag; docker by default
 * @property {(dir: string) => PackageManifest} [read] reads the manifest of a
 *   package directory of the repository
 * @property {() => string[]} [dirs] the package directories of the workspace
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/** The server of the Next standalone build, from the root of the web image. */
export const WEB_SERVER = "apps/web/server.js";

/**
 * What each image starts from beyond its manifests and `tsx`, by image name:
 * the key package of each service, the files of the web build and the
 * migrations. `tsx`, which the `CMD` of every image of `WORKSPACE_OF` loads
 * (`node --import tsx`), is checked from the directory of that table
 * whatever the manifest says, and so is the key package of each service -
 * fastify for api, bullmq for worker, drizzle-orm for migrate: a package
 * moved to devDependencies fails the probe instead of leaving it out. The
 * other packages of those images come from their manifests (`checksOf`).
 *
 * @type {Record<string, ImageCheck[]>}
 */
export const PROBES = {
  api: [{ pkg: "fastify", from: "apps/api" }],
  worker: [{ pkg: "bullmq", from: "apps/worker" }],
  migrate: [
    { pkg: "drizzle-orm", from: "packages/db" },
    { files: "packages/db/migrations", suffix: ".sql" },
    { file: "packages/db/migrations/meta/_journal.json" },
  ],
  web: [{ file: WEB_SERVER }, { pkg: "next", from: "apps/web" }],
};

/**
 * The root of the layout of each image: the repository root for the tsx
 * images, the standalone tree for web (container.test.ts holds it to the
 * WORKDIR of each target).
 *
 * @type {Record<string, string>}
 */
export const ROOT_OF = {
  api: "/repo",
  worker: "/repo",
  migrate: "/repo",
  web: "/app",
};

/**
 * The package directory each image runs from (its WORKDIR, container.test.ts),
 * whose manifest names the packages it needs. web is absent: the Next
 * standalone build bundles the workspace packages it uses.
 */
/** @type {Record<string, string>} */
export const WORKSPACE_OF = {
  api: "apps/api",
  worker: "apps/worker",
  migrate: "packages/db",
};

/**
 * External packages that are checked for their entry file, not loaded, each
 * with the reason: loading them outside the service throws by design.
 *
 * @type {Record<string, string>}
 */
export const RESOLVE_ONLY = {
  "server-only":
    "throws on import outside a React Server build, its whole purpose",
};

/**
 * Missing on purpose: the control check must fail on it.
 *
 * @type {ImageCheck}
 */
export const CONTROL = { pkg: "@sf/probe-control-never-installed", from: "." };

/**
 * What a package directory of an image must not hold, by entry name: the
 * masks of `.dockerignore` for the tests of the packages (decision R1 of
 * E0-12J) - `test` and `test-support`, `*.test.ts`, `vitest*.config.*`.
 */
export const TEST_NAMES = {
  dirs: ["test", "test-support"],
  suffix: ".test.ts",
  configPrefix: "vitest",
  configPart: ".config.",
};

/** Lines of the container's stderr (or stdout) a failure prints at most. */
export const STDERR_LINES = 20;

/**
 * How long one probe run may take: the run loads every package of the image,
 * and an import that never settles must end the probe with a reason, not
 * hold the CI job (`timeout-minutes` of docker-build) until its own timeout.
 */
export const PROBE_TIMEOUT_MS = 120_000;

/** How long removing the container of a run that timed out may take. */
export const REMOVE_TIMEOUT_MS = 30_000;

/** The tag CI builds the image with, and the tag the probe runs by default. */
export function imageTag(/** @type {string} */ image) {
  return `sf-${image}:ci`;
}

/**
 * A container name no other run takes: the run is removed by it when it does
 * not finish in time (`--rm` alone leaves a container that is still running).
 *
 * @returns {string}
 */
export function containerName() {
  return `sf-probe-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Runs inside the image under `node -e`: the root of the layout in argv[1],
 * `{ checks, control }` as JSON in argv[2]. A package is loaded by its entry
 * for the conditions `node`, `import`, `default` - an ESM-only package too,
 * which `require.resolve` would not find - found through the `node_modules`
 * of `from` and its parents up to the root. A `noTests` check walks its
 * directory, `node_modules` and links left out, and reports each entry
 * `TEST_NAMES` names. The result is the last line of stdout, whatever a
 * loaded package printed before it.
 */
export const CONTAINER_SCRIPT = `
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const [root, input] = process.argv.slice(1);
const { checks, control } = JSON.parse(input);
const CONDITIONS = ["node", "import", "default"];
const TEST_NAMES = ${JSON.stringify(TEST_NAMES)};
function isTest(name) {
  return TEST_NAMES.dirs.includes(name) || name.endsWith(TEST_NAMES.suffix) ||
    (name.startsWith(TEST_NAMES.configPrefix) && name.includes(TEST_NAMES.configPart));
}
function testsIn(dir) {
  const found = [];
  if (!existsSync(path.join(root, dir))) return found;
  const pending = [dir];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const entry of readdirSync(path.join(root, at), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relative = at + "/" + entry.name;
      if (isTest(entry.name)) found.push(relative);
      else if (entry.isDirectory()) pending.push(relative);
    }
  }
  return found.sort();
}
function pick(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = pick(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof target === "object" && target !== null) {
    for (const [key, value] of Object.entries(target)) {
      if (!CONDITIONS.includes(key)) continue;
      const found = pick(value);
      if (found !== null) return found;
    }
  }
  return null;
}
function packageDir(name, from) {
  const top = path.resolve(root);
  for (let dir = path.resolve(root, from ?? "."); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === top || path.dirname(dir) === dir) {
      throw new Error("not installed");
    }
  }
}
function entryOf(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const exported = manifest.exports;
  if (exported !== undefined) {
    const subpaths = typeof exported === "object" && exported !== null &&
      !Array.isArray(exported) && Object.keys(exported).some((key) => key.startsWith("."));
    if (subpaths && !Object.hasOwn(exported, ".")) return null;
    const target = pick(subpaths ? exported["."] : exported);
    if (target === null) throw new Error("no entry for " + CONDITIONS.join(", "));
    return path.join(dir, target);
  }
  const main = manifest.main ?? "index.js";
  for (const name of [main, main + ".js", path.join(main, "index.js")]) {
    const file = path.join(dir, name);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error("no main file");
}
async function failure(check) {
  try {
    if (check.file !== undefined) {
      if (!statSync(path.join(root, check.file)).isFile()) throw new Error("not a file");
      return null;
    }
    if (check.files !== undefined) {
      const names = readdirSync(path.join(root, check.files));
      if (!names.some((name) => name.endsWith(check.suffix))) {
        throw new Error("no file ending in " + check.suffix);
      }
      return null;
    }
    const entry = entryOf(packageDir(check.pkg, check.from));
    if (entry === null) return null;
    if (check.resolveOnly) {
      if (!statSync(entry).isFile()) throw new Error("entry is not a file");
    } else {
      await import(pathToFileURL(entry).href);
    }
    return null;
  } catch (error) {
    const label = check.file ?? check.files ?? check.pkg + " (from " + (check.from ?? ".") + ")";
    const why = error instanceof Error ? error.message.split("\\n")[0] : String(error);
    return label + ": " + why;
  }
}
(async () => {
  const missing = [];
  const tests = [];
  for (const check of checks) {
    if (check.noTests !== undefined) {
      try {
        tests.push(...testsIn(check.noTests));
      } catch (error) {
        const why = error instanceof Error ? error.message.split("\\n")[0] : String(error);
        missing.push(check.noTests + ": " + why);
      }
      continue;
    }
    const found = await failure(check);
    if (found !== null) missing.push(found);
  }
  const controlFailed = (await failure(control)) !== null;
  const line = JSON.stringify({ missing, tests, control: controlFailed ? "failed" : "passed" });
  process.stdout.write("\\n" + line + "\\n", () => process.exit(0));
})();
`;

/**
 * The checks of the packages `dir` needs: for its package and every
 * workspace package it reaches through `workspace:` links, each link (a file
 * check: the workspace packages export TypeScript, which loads only under
 * `tsx`) and each external dependency, loaded from the directory of the
 * package that depends on it. Sorted, one check per package and directory.
 *
 * @param {string} dir the package directory the image runs from
 * @param {(dir: string) => PackageManifest} read
 * @param {() => string[]} dirs
 * @returns {ImageCheck[]}
 */
export function workspaceChecks(dir, read, dirs) {
  /** @type {Map<string, string>} */
  const dirOf = new Map();
  for (const each of dirs()) dirOf.set(read(each).name, each);
  /** @type {ImageCheck[]} */
  const checks = [];
  const seen = new Set([dir]);
  const pending = [dir];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const [name, range] of Object.entries(read(at).dependencies)) {
      if (!range.startsWith("workspace:")) {
        checks.push(
          Object.hasOwn(RESOLVE_ONLY, name)
            ? { pkg: name, from: at, resolveOnly: true }
            : { pkg: name, from: at },
        );
        continue;
      }
      checks.push({ file: `${at}/node_modules/${name}/package.json` });
      const next = dirOf.get(name);
      if (next === undefined) {
        throw new Error(`${at} links ${name}, which no workspace dir holds`);
      }
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return checks.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * What a check checks, as one string: the path, the directory walked for
 * tests, or the package and the directory it loads from.
 *
 * @param {ImageCheck} check
 * @returns {string}
 */
function keyOf(check) {
  if (check.noTests !== undefined) return `tests in ${check.noTests}`;
  return check.file ?? check.files ?? `${check.from ?? "."}/${check.pkg}`;
}

/**
 * Every check of `image`: `tsx` from the directory of `WORKSPACE_OF` for the
 * images that run through it, its own table, the packages of its manifests,
 * and no tests in any package directory of the workspace.
 *
 * @param {string} image
 * @param {(dir: string) => PackageManifest} [read]
 * @param {() => string[]} [dirs]
 * @returns {ImageCheck[]}
 */
export function checksOf(
  image,
  read = readManifestFields,
  dirs = workspaceDirs,
) {
  const dir = Object.hasOwn(WORKSPACE_OF, image)
    ? WORKSPACE_OF[image]
    : undefined;
  const table = Object.hasOwn(PROBES, image) ? PROBES[image] : undefined;
  if (table === undefined) throw new Error(`no probe for image "${image}"`);
  /** @type {ImageCheck[]} */
  const own = dir === undefined ? table : [{ pkg: "tsx", from: dir }, ...table];
  // One listing of the workspace for both: each call of `dirs` asks git.
  const listed = dirs();
  const workspace =
    dir === undefined ? [] : workspaceChecks(dir, read, () => listed);
  const keys = new Set(own.map(keyOf));
  /** @type {ImageCheck[]} */
  const noTests = listed.map((each) => ({ noTests: each }));
  return [
    ...own,
    ...workspace.filter((check) => !keys.has(keyOf(check))),
    ...noTests,
  ];
}

/**
 * The `docker run` arguments of the probe: --pull=never keeps the run on the
 * image just built, --network none keeps it off every network, and the
 * container gets `name`, by which it is removed when the run does not finish
 * in time.
 *
 * @param {string} tag
 * @param {string} root
 * @param {ImageCheck[]} checks
 * @param {string} name
 * @returns {string[]}
 */
export function dockerArgs(tag, root, checks, name) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--pull=never",
    "--network",
    "none",
    "--entrypoint",
    "node",
    tag,
    "-e",
    CONTAINER_SCRIPT,
    root,
    JSON.stringify({ checks, control: CONTROL }),
  ];
}

/**
 * Runs `command` for the probe, ended with SIGKILL once `timeoutMs` is over
 * (`spawnSync` then reports an `ETIMEDOUT` error).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @param {SpawnSync} [spawn]
 * @returns {ProbeRun}
 */
export function spawnProbe(
  command,
  args,
  timeoutMs = PROBE_TIMEOUT_MS,
  spawn = spawnSync,
) {
  return spawn(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

/**
 * The probe run by docker, in a container named `name`, within
 * `PROBE_TIMEOUT_MS`. SIGKILL at the limit ends the docker CLI only, and the
 * container goes on running: a run that did not finish in time removes it
 * (`docker rm -f`, which also answers 0 for a container that never started),
 * and `cleanup` says whether that worked.
 *
 * @param {string} tag
 * @param {string} root
 * @param {ImageCheck[]} checks
 * @param {Spawn} [spawn]
 * @param {string} [name]
 * @returns {ProbeRun}
 */
export function dockerRun(
  tag,
  root,
  checks,
  spawn = spawnProbe,
  name = containerName(),
) {
  const run = spawn(
    "docker",
    dockerArgs(tag, root, checks, name),
    PROBE_TIMEOUT_MS,
  );
  if (!timedOut(run)) return run;
  const removed = spawn("docker", ["rm", "-f", name], REMOVE_TIMEOUT_MS);
  const cleanup =
    removed.status === 0
      ? `container ${name} is gone (docker rm -f)`
      : `container ${name} may still be running, docker rm -f failed: ${whyFailed(removed)}`;
  return { ...run, cleanup };
}

/**
 * Whether a run was ended by the time limit of `spawnProbe`.
 *
 * @param {ProbeRun} run
 * @returns {boolean}
 */
export function timedOut(run) {
  const { error } = run;
  return error !== undefined && "code" in error && error.code === "ETIMEDOUT";
}

/**
 * The result line of a run - the last non-blank line of its stdout - or null
 * when there is none of the expected shape.
 *
 * @param {string | null | undefined} stdout
 * @returns {ProbeResult | null}
 */
export function resultOf(stdout) {
  const last = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .at(-1);
  if (last === undefined) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { missing, tests, control } = /** @type {Record<string, unknown>} */ (
    parsed
  );
  if (
    !Array.isArray(missing) ||
    !missing.every((item) => typeof item === "string") ||
    !Array.isArray(tests) ||
    !tests.every((item) => typeof item === "string") ||
    (control !== "failed" && control !== "passed")
  ) {
    return null;
  }
  return { missing, tests, control };
}

/**
 * The first `STDERR_LINES` lines of the output `text` of a run, with a note
 * of how many more were cut.
 *
 * @param {string} text
 * @param {"stderr" | "stdout"} [stream] which output it is, for the note
 * @returns {string}
 */
export function headOf(text, stream = "stderr") {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= STDERR_LINES) return lines.join("\n");
  const cut = lines.length - STDERR_LINES;
  return [
    ...lines.slice(0, STDERR_LINES),
    `... (${cut} more lines of ${stream} cut)`,
  ].join("\n");
}

/**
 * Why a docker run failed, in one text: its stderr if there is any (the head
 * of it, `headOf`), else the error of the spawn, else exit status and signal.
 * Two readers: `main`, for a probe run that printed no result, and
 * `dockerRun`, for the `docker rm -f` of a run that did not finish in time
 * (the `cleanup` line of that run).
 *
 * @param {ProbeRun} result
 * @returns {string}
 */
function whyFailed(result) {
  const stderr = String(result.stderr ?? "").trim();
  if (stderr !== "") return headOf(stderr);
  if (result.error) return result.error.message;
  return `exit status ${result.status}, signal ${result.signal ?? "none"}`;
}

/**
 * The probe; `run` is how the check list is run against a tag (docker by
 * default), `out`/`err` where the lines go. Returns the exit code: 0 ok, 1
 * the image lacks something or carries tests, 2 the probe could not run.
 *
 * @param {string[]} argv
 * @param {ProbeDeps} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const {
    run = dockerRun,
    read = readManifestFields,
    dirs = workspaceDirs,
    out = console.log,
    err = console.error,
  } = deps;
  const [image, given] = argv;
  if (image === undefined || !Object.hasOwn(PROBES, image)) {
    err(`probe-image: unknown image "${image}"`);
    return 2;
  }
  const tag = given ?? imageTag(image);
  if (tag.startsWith("-")) {
    err(`probe-image: "${tag}" is not an image tag`);
    return 2;
  }
  /** @type {ImageCheck[]} */
  let checks;
  try {
    checks = checksOf(image, read, dirs);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    err(`probe-image: could not work out the checks of ${image}: ${cause}`);
    return 2;
  }

  const root = Object.hasOwn(ROOT_OF, image) ? ROOT_OF[image] : undefined;
  if (root === undefined) {
    err(`probe-image: no root of the layout of ${image}`);
    return 2;
  }
  const probe = run(tag, root, checks);
  if (timedOut(probe)) {
    err(
      `probe-image: the probe in ${tag} did not finish in ${PROBE_TIMEOUT_MS / 1000} s`,
    );
    if (probe.cleanup !== undefined) err(`probe-image: ${probe.cleanup}`);
    for (const stream of /** @type {const} */ (["stdout", "stderr"])) {
      const text = String(probe[stream] ?? "").trim();
      if (text !== "") {
        err(`probe-image: ${stream} of the run so far:`);
        err(headOf(text, stream));
      }
    }
    return 2;
  }
  if (probe.status !== 0) {
    err(`probe-image: could not run the probe in ${tag}`);
    err(whyFailed(probe));
    return 2;
  }
  const result = resultOf(probe.stdout);
  if (result === null) {
    err(`probe-image: probe printed no result in ${tag}`);
    const stderr = String(probe.stderr ?? "").trim();
    if (stderr !== "") err(headOf(stderr));
    return 2;
  }
  if (result.missing.length > 0) {
    err(`probe-image: ${tag} is missing what it starts from`);
    err(`probe-image: missing ${result.missing.join(", ")}`);
  }
  if (result.tests.length > 0) {
    err(`probe-image: ${tag} carries the tests of its packages`);
    err(`probe-image: tests ${result.tests.join(", ")}`);
  }
  if (result.missing.length > 0 || result.tests.length > 0) return 1;
  if (result.control !== "failed") {
    err(`probe-image: the control check did not fail on ${tag}`);
    return 1;
  }
  out(`probe-image: ${tag} ok (${checks.length} checks, control red)`);
  return 0;
}

if (isEntry(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
