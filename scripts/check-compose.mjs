#!/usr/bin/env node
/**
 * Gate: invariants of the full Compose stack (compose.yaml at the root, which
 * includes infra/docker-compose.yml and infra/docker-compose.app.yml) that a
 * running stack would only reveal by failing - or by not failing where it
 * should. The rules and their reasons: `compose-rules.mjs`.
 *
 * Reads the configuration through `docker compose config`, so includes,
 * anchors and merges are resolved the way Compose resolves them. No `.env` is
 * read: the interpolation of the Compose files gets an empty env file instead
 * of the root `.env`, so the gate checks the files with their defaults, never
 * sees a secret, and answers the same on every machine. The `.env` the app
 * services mount is a path to the gate, not contents. Needs the Docker CLI,
 * not a running daemon.
 *
 * Besides the configuration it reads the `.dockerignore` of every build
 * context and looks for a `<Dockerfile>.dockerignore` next to each Dockerfile
 * (rule 11), reads the root `.env.test` - local Compose addresses, no
 * secrets - for the ports of the test stack (rule 12): files, not secrets.
 *
 * `--no-env-resolution`: without it `docker compose config` replaces every
 * `env_file` by the variables read from it, so a service that still has an
 * `env_file` would be indistinguishable from one with an `environment`, and
 * rule 10 (no `env_file` on any service) could not see it.
 *
 * Before the stack it renders `RENDERING_PROBE` (rule 10 of
 * compose-rules.mjs): a Compose that drops `create_host_path: false` from
 * its output would make the rule fail a correct file or pass a broken one, so
 * the gate stops and names the version instead.
 *
 * Compose takes the directory of the first file as the project directory and
 * resolves the bind source `../.env` against it; the gate expects the
 * project's `.env` at the root of the repository, so it takes only a file
 * that lies there and refuses any other with a hint, rather than failing
 * rule 10 for a path the stack never mounts. Both the file and the root go
 * through the native realpath first - the canonical case of every letter on
 * Windows, the target of a junction, a `subst` drive or a symlink - and the
 * gate hands Compose that path, so the `.env` rule 10 expects is built from
 * the same root Compose resolves the mount against.
 *
 * Usage: `node scripts/check-compose.mjs [compose file]`.
 * Exit 1 with every violation listed, or with why the configuration could not
 * be read; exit 0 when clean.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  RENDERING_PROBE,
  RENDERING_PROBE_SOURCE,
  checkCompose,
  checkRendering,
  defaultComposeFile,
} from "./compose-rules.mjs";
import { isGone, readIfFile } from "./lib/files.mjs";
import { canonical, isEntry, repoRoot } from "./lib/paths.mjs";

/**
 * What `main` works with; each has a default that reaches docker, the disk
 * and the console.
 *
 * @typedef {object} GateDeps
 * @property {(args: string[]) => string} [compose] `docker compose` with
 *   `args`, its standard output; throws as `execFileSync` does
 * @property {(path: string) => string | null} [read] contents of a file,
 *   null if there is none
 * @property {(path: string) => string} [realpath] the canonical path of an
 *   existing one, throwing for any other; the default is the one of
 *   `canonical`
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/**
 * `docker compose` with `args`, its standard output.
 *
 * @param {string[]} args
 * @returns {string}
 */
function dockerCompose(args) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * What docker printed when a call failed, else why it could not run.
 *
 * @param {unknown} error
 * @returns {string}
 */
function detailOf(error) {
  if (!(error instanceof Error)) return String(error);
  return "stderr" in error && error.stderr != null
    ? String(error.stderr)
    : error.message;
}

/**
 * A file the rules asked for and could not read, with its path: the failure
 * carries what it is about, so no other record of the reads is kept.
 */
class UnreadableInputError extends Error {
  /**
   * @param {string} path
   * @param {unknown} cause the failure of the read
   */
  constructor(path, cause) {
    super(`cannot read ${path}`, { cause });
    this.name = "UnreadableInputError";
    /** @readonly */
    this.path = path;
  }
}

/**
 * The gate. Returns the exit code: 0 clean, 1 a violation or a configuration
 * that could not be read.
 *
 * @param {string[]} argv
 * @param {GateDeps} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const {
    compose = dockerCompose,
    read = readIfFile,
    realpath,
    out = console.log,
    err = console.error,
  } = deps;
  const given = resolve(argv[0] ?? defaultComposeFile());
  /**
   * The canonical path of `path`, or null with the failure printed.
   *
   * @param {string} path
   * @param {string} what how the message names it
   * @returns {string | null}
   */
  const resolved = (path, what) => {
    try {
      return canonical(path, realpath);
    } catch (error) {
      err(`check-compose: cannot resolve ${what} ${path}`);
      err(detailOf(error instanceof Error ? error.cause : error));
      return null;
    }
  };
  const file = resolved(given, "the Compose file");
  if (file === null) return 1;
  const root = resolved(repoRoot, "the root of the repository");
  if (root === null) return 1;
  if (dirname(file) !== root) {
    err(
      `check-compose: ${file} is not at the root of the repository - Compose would take ${dirname(file)} as the project directory; check the root compose.yaml (node scripts/check-compose.mjs), which includes the files of infra/`,
    );
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), "sf-check-compose-"));
  try {
    const emptyEnvFile = join(scratch, "empty.env");
    writeFileSync(emptyEnvFile, "");
    const probeFile = join(scratch, "probe.yaml");
    writeFileSync(probeFile, RENDERING_PROBE);
    writeFileSync(join(scratch, RENDERING_PROBE_SOURCE), "");

    /**
     * The resolved configuration of `composeFile`, as JSON.
     *
     * @param {string} composeFile
     * @returns {unknown}
     */
    const render = (composeFile) =>
      JSON.parse(
        compose([
          "--env-file",
          emptyEnvFile,
          "-f",
          composeFile,
          "config",
          "--no-env-resolution",
          "--format",
          "json",
        ]),
      );

    /**
     * Runs `step`; on a failure prints `what` failed (or that there is no
     * Docker CLI) and gives null.
     *
     * @template T
     * @param {string} what
     * @param {() => T} step
     * @returns {{ value: T } | null}
     */
    const attempt = (what, step) => {
      try {
        return { value: step() };
      } catch (error) {
        if (isGone(error)) {
          // No Docker CLI is a missing prerequisite, not a broken file.
          err(
            "check-compose: the docker CLI is not on PATH - install Docker (the daemon is not needed); the Compose files were not checked",
          );
        } else {
          err(`check-compose: ${what}`);
          err(detailOf(error));
        }
        return null;
      }
    };

    const probe = attempt(
      "docker compose config failed for the rendering probe - the Compose CLI itself, not a file of this repository",
      () => render(probeFile),
    );
    if (probe === null) return 1;
    const rendering = checkRendering(probe.value);
    if (rendering.length > 0) {
      err("check-compose: the rendering probe failed");
      for (const problem of rendering) err(`  ${problem}`);
      const version = attempt(
        "docker compose version failed after the rendering probe failed",
        () => compose(["version", "--short"]).trim(),
      );
      if (version !== null) err(`  docker compose version: ${version.value}`);
      return 1;
    }

    const config = attempt(`docker compose config failed for ${file}`, () =>
      render(file),
    );
    if (config === null) return 1;
    /** @type {(path: string) => string | null} */
    const readInput = (path) => {
      try {
        return read(path);
      } catch (error) {
        throw new UnreadableInputError(path, error);
      }
    };
    /** @type {string[]} */
    let problems;
    try {
      problems = checkCompose(config.value, {
        envFile: join(root, ".env"),
        testEnvFile: join(root, ".env.test"),
        read: readInput,
      });
    } catch (error) {
      if (!(error instanceof UnreadableInputError)) throw error;
      err(`check-compose: cannot read ${error.path}, a file the rules check`);
      err(detailOf(error.cause));
      return 1;
    }
    if (problems.length > 0) {
      err(`check-compose: ${file}`);
      for (const problem of problems) err(`  ${problem}`);
      return 1;
    }
    out("check-compose: clean");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
