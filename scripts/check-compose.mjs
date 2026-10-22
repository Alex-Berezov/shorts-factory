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
 * What the operator's `.env` may change is checked without reading it
 * (docs/adr/0014-compose-graph-gate.md): `config --variables` names every
 * variable the Compose files read, each must be one of `INTERPOLATED` of
 * compose-rules.mjs and not required, and a second render, with a control
 * value for each, may differ from the first only in the fields listed for
 * that variable (`checkInterpolation`). Both renders take `--profile '*'`, so
 * a service behind a profile reaches the rules (rule 16), as does every file
 * of the graph of the root file (rules 14, 15 and 17, read from the disk).
 *
 * docker runs with a copy of the environment of the gate, taken name by name:
 * without any `COMPOSE_*` and without the variables of the Compose files, so
 * neither the shell nor a `COMPOSE_PROFILES` there renders another stack than
 * the files give; on Windows the names are compared without their case, as
 * Windows reads them. Any `COMPOSE_*` set in that environment - but the ones
 * of `HARMLESS`, which change how Compose prints, not what it brings up -
 * fails the gate before docker runs: `docker compose up` from the same shell
 * would bring up another stack than the one checked (`COMPOSE_FILE`,
 * `COMPOSE_PROFILES`, `COMPOSE_ENV_FILES` measured,
 * tasks/2026-10-20-E0-12K.md). The values are never printed, only the names.
 * A `COMPOSE_*` written in the root `.env` changes the stack of `docker
 * compose up` as well, and the gate, which does not read `.env`, does not
 * see it (docs/TECH_DEBT.md, E1-12).
 *
 * Besides the configuration it reads the `.dockerignore` of every build
 * context and looks for a `<Dockerfile>.dockerignore` next to each Dockerfile
 * (rule 11), reads the root `.env.test` - local Compose addresses, no
 * secrets - for the ports of the test stack (rule 12), the Compose files of
 * the graph (rule 15; a file outside `COMPOSE_SOURCES` it names, not opens),
 * and looks for an override, another Compose file of a default name or a
 * `.env` next to them (rule 14) without opening it: files, not secrets.
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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  RENDERING_PROBE,
  RENDERING_PROBE_SOURCE,
  checkCompose,
  checkInterpolation,
  checkRendering,
  checkVariables,
  controlEnvOf,
  defaultComposeFile,
} from "./compose-rules.mjs";
import { isGone, messageOf, readIfFile } from "./lib/files.mjs";
import { canonical, isEntry, nameOn, repoRoot } from "./lib/paths.mjs";

/**
 * An environment of a process, by name.
 *
 * @typedef {Record<string, string | undefined>} Environment
 */

/**
 * What `main` works with; each has a default that reaches docker, the disk,
 * the environment of the process and the console.
 *
 * @typedef {object} GateDeps
 * @property {(args: string[], env: Environment) => string} [compose]
 *   `docker compose` with `args` in the environment `env`, its standard
 *   output; throws as `execFileSync` does
 * @property {(path: string) => string | null} [read] contents of a file,
 *   null if there is none
 * @property {(path: string) => string} [realpath] the canonical path of an
 *   existing one, throwing for any other - with the code `ENOENT` for a path
 *   that is not there; the default is the native realpath, the one of
 *   `canonical`
 * @property {Environment} [env] the environment of the gate, the one docker
 *   gets a copy of; the default is the environment of this process
 * @property {string} [platform] whose rules the names of `env` follow
 *   (`win32` compares them without their case); the default is this one
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/**
 * `docker compose` with `args` in the environment `env`, its standard output.
 *
 * @param {string[]} args
 * @param {Environment} env
 * @returns {string}
 */
function dockerCompose(args, env) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The `COMPOSE_*` variables of the environment that change how Compose talks
 * and prints, not the stack it brings up: colours, progress, the menu, how
 * many calls at once, what it says of orphans. Every other `COMPOSE_*` set in
 * the shell of the gate - `COMPOSE_FILE`, `COMPOSE_PROFILES`,
 * `COMPOSE_ENV_FILES`, `COMPOSE_PROJECT_NAME`, `COMPOSE_DISABLE_ENV_FILE`, a
 * new one of a later Compose - would be set for the operator's command too,
 * and may bring up another stack than the one checked.
 */
const HARMLESS = [
  "COMPOSE_ANSI",
  "COMPOSE_PROGRESS",
  "COMPOSE_STATUS_STDOUT",
  "COMPOSE_MENU",
  "COMPOSE_PARALLEL_LIMIT",
  "COMPOSE_IGNORE_ORPHANS",
  "COMPOSE_REMOVE_ORPHANS",
];

/**
 * Whether `name` of an environment is a `COMPOSE_*` variable, by the name the
 * platform reads (`nameOn`) - the one test `stackChangingIn` and `dockerEnvOf`
 * take, so the variables the gate refuses and the ones it drops for docker
 * cannot drift apart.
 *
 * @param {string} name
 * @param {string} platform
 * @returns {boolean}
 */
function isComposeVariable(name, platform) {
  return nameOn(name, platform).startsWith("COMPOSE_");
}

/**
 * The names of `env` that are a `COMPOSE_*` outside `HARMLESS` and hold a
 * value, as `env` writes them; the names are compared the way the platform
 * reads them (`nameOn`).
 *
 * @param {Environment} env
 * @param {string} platform
 * @returns {string[]}
 */
function stackChangingIn(env, platform) {
  return Object.keys(env).filter(
    (name) =>
      isComposeVariable(name, platform) &&
      !HARMLESS.includes(nameOn(name, platform)) &&
      (env[name] ?? "") !== "",
  );
}

/**
 * A copy of `env` for docker, taken name by name: without any `COMPOSE_*`
 * and without the names of `dropped` (the variables of the Compose files),
 * compared the way the platform reads them. `DOCKER_*` and the rest stay - the
 * Compose plugin is found through them.
 *
 * @param {Environment} env
 * @param {string} platform
 * @param {readonly string[]} dropped
 * @returns {Environment}
 */
function dockerEnvOf(env, platform, dropped) {
  const drop = new Set(dropped.map((name) => nameOn(name, platform)));
  /** @type {Environment} */
  const copy = {};
  for (const name of Object.keys(env)) {
    if (isComposeVariable(name, platform) || drop.has(nameOn(name, platform)))
      continue;
    copy[name] = env[name];
  }
  return copy;
}

/**
 * How a failed call of docker ended when it ran - `exited with code N`,
 * `was ended by SIGTERM`, or a limit of the gate (more output than the buffer of the call holds,
 * `ENOBUFS`, which Node ends with SIGTERM), told by the
 * code of the failure before its signal - or undefined when it never started
 * (a failure of the spawn itself, `ENOENT` among them, carries no status and
 * no signal). A call that ran fails with `execFileSync`'s `Command failed: …`,
 * the whole stderr appended.
 *
 * @param {unknown} error
 * @returns {{ text: string, gateLimit: boolean } | undefined}
 */
function endingOf(error) {
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOBUFS") {
    return {
      text: "printed more than the gate reads (ENOBUFS)",
      gateLimit: true,
    };
  }
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
  if (ending === undefined) return [messageOf(error)];
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

/** What stands for the control env file of the gate in a command to repeat. */
const CONTROL_ENV_PLACEHOLDER = "<control env file>";

/**
 * The gate. Returns the exit code: 0 clean, 1 a violation or a configuration
 * that could not be read.
 *
 * Calls docker in this order: the rendering probe, the variables of the
 * stack, the stack with an empty env file, the stack with the control values
 * - and only then the rules, on the first of the two renders.
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
    // The gate hands docker a copy of its own environment, by name, and
    // prints names only (docs/adr/0014-compose-graph-gate.md).
    env = process.env,
    platform = process.platform,
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
      err(messageOf(error instanceof Error ? error.cause : error));
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
  const changing = stackChangingIn(env, platform);
  if (changing.length > 0) {
    for (const name of changing) {
      err(
        `check-compose: ${name} is set in the environment of the gate - docker compose up from this shell would bring up another stack than the one checked; unset it and run the gate again (its value is not printed)`,
      );
    }
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
     * The arguments of `docker compose config` for `composeFile`, with
     * `envFile` for the interpolation and every profile on, and `output` -
     * what it prints: one list of the flags for every call, so the
     * variables and the renders read the same stack.
     *
     * @param {string} composeFile
     * @param {string} envFile
     * @param {string[]} output
     * @returns {string[]}
     */
    const configArgs = (composeFile, envFile, output) => [
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "*",
      "config",
      ...output,
      "--format",
      "json",
    ];
    /**
     * The arguments that render `composeFile` as JSON.
     *
     * @param {string} composeFile
     * @param {string} [envFile]
     * @returns {string[]}
     */
    const renderArgs = (composeFile, envFile = emptyEnvFile) =>
      configArgs(composeFile, envFile, ["--no-env-resolution"]);
    /**
     * The arguments that list the variables the Compose files read.
     *
     * @param {string} envFile
     * @returns {string[]}
     */
    const variablesArgs = (envFile) =>
      configArgs(file, envFile, ["--variables"]);
    /** @type {(stdout: string) => unknown} */
    const parse = (stdout) => JSON.parse(stdout);
    /** The environment of every call before the variables are known. */
    let dockerEnv = dockerEnvOf(env, platform, []);

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
        stdout = compose(args, dockerEnv);
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

    const variables = attempt(
      `docker compose config --variables failed for ${file}`,
      variablesArgs(emptyEnvFile),
      parse,
      (ending) => [
        ...repeatable(
          commandOf(variablesArgs(EMPTY_ENV_PLACEHOLDER)),
          true,
        )(ending),
        "  (create an empty file and pass its path as --env-file)",
      ],
    );
    if (variables === null) return 1;
    const known = checkVariables(variables.value);
    if (known.problems.length > 0) {
      err(`check-compose: ${file}`);
      for (const problem of known.problems) err(`  ${problem}`);
      return 1;
    }
    // From here on neither the shell nor the operator's environment gives a
    // variable of the Compose files a value: only the env file of the call.
    dockerEnv = dockerEnvOf(env, platform, known.names);

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
    const controlEnvFile = join(scratch, "control.env");
    writeFileSync(controlEnvFile, controlEnvOf(known.names));
    const controlled = attempt(
      `docker compose config failed for ${file} with the control values of its variables`,
      renderArgs(file, controlEnvFile),
      parse,
      (ending) => [
        ...repeatable(
          commandOf(renderArgs(file, CONTROL_ENV_PLACEHOLDER)),
          true,
        )(ending),
        "  (pass as --env-file a file with NAME=control for each variable of INTERPOLATED in scripts/compose-rules.mjs)",
      ],
    );
    if (controlled === null) return 1;

    /** @type {(path: string) => string | null} */
    const readInput = (path) => {
      try {
        return read(path);
      } catch (error) {
        throw new UnreadableInputError(path, error);
      }
    };
    const resolvePath = realpath ?? realpathSync.native;
    /** @type {(path: string) => string} */
    const realpathInput = (path) => {
      try {
        return resolvePath(path);
      } catch (error) {
        // Not there is an answer the rules take; anything else is not.
        if (isGone(error)) throw error;
        throw new UnreadableInputError(path, error);
      }
    };
    /** @type {string[]} */
    let problems;
    try {
      problems = [
        ...checkCompose(config.value, {
          composeFile: file,
          envFile: join(root, ".env"),
          testEnvFile: join(root, ".env.test"),
          read: readInput,
          realpath: realpathInput,
          platform,
        }),
        ...checkInterpolation(config.value, controlled.value),
      ];
    } catch (error) {
      if (!(error instanceof UnreadableInputError)) throw error;
      err(`check-compose: cannot read ${error.path}, a file the rules check`);
      err(messageOf(error.cause));
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
