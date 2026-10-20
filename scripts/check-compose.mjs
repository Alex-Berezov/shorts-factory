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
 * Why a read of a file or a path failed: its message. Not for a call of
 * docker - see `composeFailureOf`.
 *
 * @param {unknown} error
 * @returns {string}
 */
function detailOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The codes `execFileSync` gives a call it ended itself, on a limit of the
 * gate rather than on anything docker did: more output than the buffer of
 * the call holds, or a call past its time limit. Node ends such a call with
 * SIGTERM, so without the code it reads as a docker somebody stopped.
 */
const GATE_LIMITS = {
  ENOBUFS: "printed more than the gate reads (ENOBUFS)",
  ETIMEDOUT: "ran past the time limit of the gate (ETIMEDOUT)",
};

/**
 * How a failed call of docker ended when it ran - `exited with code N`,
 * `was ended by SIGTERM`, or a limit of the gate (`GATE_LIMITS`), told by the
 * code of the failure before its signal - or undefined when it never started
 * (`ENOENT` and any other failure of the spawn itself). A call that ran fails
 * with `execFileSync`'s `Command failed: …`, the whole stderr appended.
 *
 * @param {unknown} error
 * @returns {{ text: string, gateLimit: boolean } | undefined}
 */
function endingOf(error) {
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOBUFS" || code === "ETIMEDOUT") {
    return { text: GATE_LIMITS[code], gateLimit: true };
  }
  if (code === "ENOENT") return undefined;
  const status = "status" in error ? error.status : undefined;
  if (typeof status === "number") {
    return { text: `exited with code ${status}`, gateLimit: false };
  }
  const signal = "signal" in error ? error.signal : undefined;
  if (signal !== undefined && signal !== null) {
    return { text: `was ended by ${String(signal)}`, gateLimit: false };
  }
  return undefined;
}

/**
 * One argument as a shell takes it back: as it is when it holds only letters,
 * digits, `_`, `.`, `/`, `:` and `-`, otherwise in single quotes, inside
 * which neither a POSIX shell nor PowerShell expands `$`, a backquote or a
 * backslash - so a Windows path, with its backslashes, is always quoted. A
 * single quote inside is written the POSIX way (`'\''`), which PowerShell
 * does not take: `commandOf` says so on a line of its own.
 *
 * @param {string} arg
 * @returns {string}
 */
function shellArg(arg) {
  return /^[\w./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * `docker compose` with `args` as a shell takes it back: the command, and -
 * for a line of its own, so the command copies whole - the shell named when
 * only a POSIX one takes it (an argument with a single quote in it).
 *
 * @param {string[]} args
 * @returns {{ command: string, note: string | undefined }}
 */
function commandOf(args) {
  return {
    command: `docker ${["compose", ...args].map(shellArg).join(" ")}`,
    note: args.some((arg) => arg.includes("'"))
      ? "(POSIX sh quoting)"
      : undefined,
  };
}

/**
 * What the gate says of a call of docker that failed (docs/DECISIONS.md, Т7
 * E0-12G): nothing docker printed. `docker compose config` writes to stderr
 * what it could not interpolate or parse, and that can be a value out of
 * `.env` - a key, a password - which the gate would put into the log of CI and
 * of the gate hook. So a call that ran and failed is told by how it ended,
 * in the words `ranAndFailed` gives it - for a call a person can repeat, with
 * the command, where its stderr reaches only the terminal of whoever runs it;
 * the message of such a failure is `Command failed: …` with the stderr
 * appended, and is not printed either. A call that never started - the spawn
 * itself refused - carries no output of docker, and its message is printed as
 * it is.
 *
 * @param {unknown} error
 * @param {(ending: string) => string[]} ranAndFailed the lines for a call
 *   that ran and failed, given how it ended
 * @returns {string[]}
 */
function composeFailureOf(error, ranAndFailed) {
  const ending = endingOf(error);
  if (ending === undefined) return [detailOf(error)];
  // Not a command to repeat: by hand the call would not meet the limit.
  if (ending.gateLimit) {
    return [
      `  docker compose ${ending.text} - a limit of this gate, not a fault of the Compose files; what it printed is not repeated here`,
    ];
  }
  return ranAndFailed(ending.text);
}

/**
 * The lines for a call that ran and failed and that a person can repeat: how
 * it ended, and the command to read what it printed, with its note on the
 * line under it. `fromEnv` says whether the call interpolates `.env`, the
 * reason its output is withheld.
 *
 * @param {{ command: string, note: string | undefined }} repeat what
 *   `commandOf` gives
 * @param {boolean} fromEnv
 * @returns {(ending: string) => string[]}
 */
function repeatable({ command, note }, fromEnv) {
  const why = fromEnv
    ? "what it printed is not repeated here - it can carry values from .env"
    : "what it printed is not repeated here";
  return (ending) => [
    `  docker compose ${ending}; ${why}`,
    `  to read it, run: ${command}`,
    ...(note === undefined ? [] : [`  ${note}`]),
  ];
}

/** What stands for the empty env file of the gate in a command to repeat. */
const EMPTY_ENV_PLACEHOLDER = "<empty env file>";

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
     * The arguments that render `composeFile` as JSON, with `envFile` for
     * the interpolation.
     *
     * @param {string} composeFile
     * @param {string} [envFile]
     * @returns {string[]}
     */
    const renderArgs = (composeFile, envFile = emptyEnvFile) => [
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ];
    /** @type {(stdout: string) => unknown} */
    const parse = (stdout) => JSON.parse(stdout);

    /**
     * Runs `docker compose` with `args` and hands its output to `then`; on a
     * failure prints `what` failed (or that there is no Docker CLI) and gives
     * null. `ranAndFailed` words a call that ran and failed.
     *
     * @template T
     * @param {string} what
     * @param {string[]} args
     * @param {(stdout: string) => T} then
     * @param {(ending: string) => string[]} ranAndFailed
     * @returns {{ value: T } | null}
     */
    const attempt = (what, args, then, ranAndFailed) => {
      /** @type {string} */
      let stdout;
      try {
        stdout = compose(args);
      } catch (error) {
        if (isGone(error)) {
          // No Docker CLI is a missing prerequisite, not a broken file.
          err(
            "check-compose: the docker CLI is not on PATH - install Docker (the daemon is not needed); the Compose files were not checked",
          );
        } else {
          err(`check-compose: ${what}`);
          for (const line of composeFailureOf(error, ranAndFailed)) err(line);
        }
        return null;
      }
      try {
        return { value: then(stdout) };
      } catch {
        // What docker answered is not what was asked for (not JSON): the
        // call itself went through, so this is the failure of reading it. Its
        // message is not printed: `JSON.parse` quotes the input it choked on,
        // and that is the stdout of docker.
        err(`check-compose: ${what}`);
        err(
          `  stdout is not JSON (${Buffer.byteLength(stdout, "utf8")} bytes)`,
        );
        return null;
      }
    };

    const probe = attempt(
      "docker compose config failed for the rendering probe - the Compose CLI itself, not a file of this repository",
      renderArgs(probeFile),
      parse,
      // Not the command: its files are the gate's own, in a directory removed
      // by the time anyone reads this, and nothing in them is the operator's.
      (ending) => [
        `  the rendering probe built into the gate failed: docker compose ${ending}; run \`docker compose version\``,
      ],
    );
    if (probe === null) return 1;
    const rendering = checkRendering(probe.value);
    if (rendering.length > 0) {
      err("check-compose: the rendering probe failed");
      for (const problem of rendering) err(`  ${problem}`);
      const version = attempt(
        "docker compose version failed after the rendering probe failed",
        ["version", "--short"],
        (stdout) => stdout.trim(),
        repeatable(commandOf(["version", "--short"]), false),
      );
      if (version !== null) err(`  docker compose version: ${version.value}`);
      return 1;
    }

    const config = attempt(
      `docker compose config failed for ${file}`,
      renderArgs(file),
      parse,
      (ending) => [
        ...repeatable(
          commandOf(renderArgs(file, EMPTY_ENV_PLACEHOLDER)),
          true,
        )(ending),
        "  (create an empty file and pass its path as --env-file)",
      ],
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
