#!/usr/bin/env node
/**
 * Gate: an image whose install put nothing in place must not pass.
 *
 * `node scripts/probe-image.mjs <image> [tag]` runs the built image (tag
 * defaults to `sf-<image>:ci`) once and checks, from its WORKDIR, that the
 * files and packages the service starts from are there, and that every
 * workspace package (`@sf/*`) its manifest depends on is linked into its
 * `node_modules`. Then it runs the same check with one package that cannot
 * exist and requires that run to fail: a probe that cannot turn red proves
 * nothing.
 *
 * Exit 1: the image lacks something, or the control run did not fail.
 * Exit 2: the probe could not run (unknown image, a tag that reads as a flag,
 * docker itself failing, a manifest that cannot be read) - nothing is known about the image.
 *
 * Used by the `docker-build` job of .github/workflows/ci.yml, one image per
 * matrix element, so all four images are probed the same way.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry, repoRoot } from "./lib/paths.mjs";

/**
 * One check inside an image: `file` must exist, or `pkg` must resolve from
 * the directory `from` (the WORKDIR when absent).
 *
 * @typedef {object} ImageCheck
 * @property {string} [file]
 * @property {string} [pkg]
 * @property {string} [from]
 */

/**
 * What one probe run returned, as `spawnSync` reports it.
 *
 * @typedef {object} ProbeRun
 * @property {number | null} status
 * @property {string | null} stderr
 * @property {string | null} [signal]
 * @property {Error} [error]
 */

/**
 * What `main` works with; each has a default that reaches docker, the
 * repository and the console.
 *
 * @typedef {object} ProbeDeps
 * @property {(tag: string, checks: ImageCheck[]) => ProbeRun} [run] runs one
 *   check list against an image tag; docker by default
 * @property {(dir: string) => unknown} [read] reads the manifest of a package
 *   directory of the repository
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/**
 * What each image starts from, by image name.
 *
 * @type {Record<string, ImageCheck[]>}
 */
export const PROBES = {
  api: [{ pkg: "fastify" }, { pkg: "tsx" }],
  worker: [{ pkg: "bullmq" }, { pkg: "tsx" }],
  migrate: [{ pkg: "drizzle-orm" }, { pkg: "tsx" }],
  web: [{ file: "apps/web/server.js" }, { pkg: "next", from: "apps/web" }],
};

/**
 * The package directory each image runs from (its WORKDIR, container.test.ts),
 * whose manifest names the workspace packages it needs. web is absent: the
 * Next standalone build bundles the workspace packages it uses.
 */
/** @type {Record<string, string>} */
export const WORKSPACE_OF = {
  api: "apps/api",
  worker: "apps/worker",
  migrate: "packages/db",
};

/**
 * Missing on purpose: the control run must fail on it.
 *
 * @type {{ pkg: string }}
 */
export const CONTROL = { pkg: "@sf/probe-control-never-installed" };

/** Printed by the program in the image when a check fails. */
const MISSING_MARKER = "probe: missing ";

/** Runs inside the image under `node -e`; the checks arrive as JSON in argv[1]. */
export const CONTAINER_SCRIPT = `
const { accessSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const missing = [];
for (const check of JSON.parse(process.argv[1])) {
  try {
    if (check.file) accessSync(check.file);
    else createRequire(path.resolve(check.from ?? ".", "probe.js")).resolve(check.pkg);
  } catch {
    missing.push(check.file ?? check.pkg);
  }
}
if (missing.length > 0) {
  console.error(${JSON.stringify(MISSING_MARKER)} + missing.join(", "));
  process.exit(1);
}
`;

/**
 * One check per workspace dependency of a manifest: the link pnpm makes in
 * the package's `node_modules` must lead to a package. A file check, not a
 * resolve: the workspace packages export TypeScript under `import` only.
 *
 * @param {unknown} manifest
 * @returns {ImageCheck[]}
 */
export function workspaceChecks(manifest) {
  const dependencies =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "dependencies")
      : undefined;
  return Object.entries(
    typeof dependencies === "object" && dependencies !== null
      ? dependencies
      : {},
  )
    .filter(([, range]) => String(range).startsWith("workspace:"))
    .map(([name]) => ({ file: `node_modules/${name}/package.json` }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The manifest of a package directory of the repository, parsed JSON of no
 * checked shape (`test/repo-files.ts` `readManifest` is the typed reader of
 * the root tests).
 *
 * @param {string} dir relative to the repository root
 * @returns {unknown}
 */
function readManifestJson(dir) {
  return JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
}

/**
 * Every check of `image`: its own table and its workspace links.
 *
 * @param {string} image
 * @param {(dir: string) => unknown} [read]
 * @returns {ImageCheck[]}
 */
export function checksOf(image, read = readManifestJson) {
  const dir = Object.hasOwn(WORKSPACE_OF, image)
    ? WORKSPACE_OF[image]
    : undefined;
  const own = Object.hasOwn(PROBES, image) ? PROBES[image] : undefined;
  if (own === undefined) throw new Error(`no probe for image "${image}"`);
  const workspace = dir === undefined ? [] : workspaceChecks(read(dir));
  return [...own, ...workspace];
}

/**
 * The `docker run` arguments of one probe; --pull=never keeps the run on the image just built.
 *
 * @param {string} tag
 * @param {ImageCheck[]} checks
 * @returns {string[]}
 */
export function dockerArgs(tag, checks) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--entrypoint",
    "node",
    tag,
    "-e",
    CONTAINER_SCRIPT,
    JSON.stringify(checks),
  ];
}

/**
 * One probe run by docker.
 *
 * @param {string} tag
 * @param {ImageCheck[]} checks
 * @returns {ProbeRun}
 */
function dockerRun(tag, checks) {
  return spawnSync("docker", dockerArgs(tag, checks), { encoding: "utf8" });
}

/**
 * A run that reached the program in the image and found something missing.
 *
 * @param {ProbeRun} result
 * @returns {boolean}
 */
const foundMissing = (result) =>
  result.status === 1 && String(result.stderr).includes(MISSING_MARKER);

/**
 * Why a run printed nothing: stderr if there is any, else error, status, signal.
 *
 * @param {ProbeRun} result
 * @returns {string}
 */
function whyFailed(result) {
  const stderr = String(result.stderr ?? "").trim();
  if (stderr !== "") return stderr;
  if (result.error) return result.error.message;
  return `exit status ${result.status}, signal ${result.signal ?? "none"}`;
}

/**
 * The probe; `run` is how one check list is run against a tag (docker by
 * default), `out`/`err` where the lines go. Returns the exit code: 0 ok, 1
 * the image lacks something, 2 the probe could not run.
 *
 * @param {string[]} argv
 * @param {ProbeDeps} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const {
    run = dockerRun,
    read = readManifestJson,
    out = console.log,
    err = console.error,
  } = deps;
  const [image, given] = argv;
  if (image === undefined || !Object.hasOwn(PROBES, image)) {
    err(`probe-image: unknown image "${image}"`);
    return 2;
  }
  const tag = given ?? `sf-${image}:ci`;
  if (tag.startsWith("-")) {
    err(`probe-image: "${tag}" is not an image tag`);
    return 2;
  }
  /** @type {ImageCheck[]} */
  let checks;
  try {
    checks = checksOf(image, read);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    err(`probe-image: could not work out the checks of ${image}: ${cause}`);
    return 2;
  }

  const real = run(tag, checks);
  if (real.status !== 0) {
    if (foundMissing(real)) {
      err(`probe-image: ${tag} is missing what it starts from`);
      err(String(real.stderr).trim());
      return 1;
    }
    err(`probe-image: could not run the probe in ${tag}`);
    err(whyFailed(real));
    return 2;
  }
  const control = run(tag, [...checks, CONTROL]);
  if (control.status !== 0 && !foundMissing(control)) {
    err(`probe-image: could not run the control probe in ${tag}`);
    err(whyFailed(control));
    return 2;
  }
  if (!foundMissing(control) || !String(control.stderr).includes(CONTROL.pkg)) {
    err(`probe-image: the control check did not fail on ${tag}`);
    err(String(control.stderr).trim());
    return 1;
  }
  out(`probe-image: ${tag} ok (${checks.length} checks, control red)`);
  return 0;
}

if (isEntry(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
