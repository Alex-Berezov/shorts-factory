import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/check-compose.mjs";
import { INTERPOLATED } from "../scripts/compose-rules.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  CLEAN_ROOT_COMPOSE,
  cleanFilesAt,
  cleanStack,
  realpathIn,
} from "./compose-fixture.js";
import { dropLink } from "./drop-link.js";

/**
 * How the compose gate fails before it gets a configuration, run as CI and
 * the gate hook run it - a child process. No docker is started: without the
 * CLI on PATH the gate names the missing prerequisite (its spawn answers
 * `ENOENT`, `isGone` of `scripts/lib/files.mjs`); any other failure of the
 * call - here one without a code, made by a module preloaded into the child
 * (`--import`) in place of `execFileSync` - is a broken Compose file.
 */
const SCRIPT = join(repoRoot, "scripts", "check-compose.mjs");

/** A run of the gate that starts no docker takes well under a second. */
const TIMEOUT_MS = 20_000;

/** The scratch directory of this file, made before its first case. */
let scratch = "";
/** A junction to the real root of the repository, made by one case only. */
let rootLink = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "sf-check-compose-test-"));
  rootLink = join(scratch, "linked-checkout");
});
afterAll(() => {
  // No directory was made: nothing to take off.
  if (scratch === "") return;
  // The link goes first on its own: a recursive remove must never walk through
  // it into the real repository. A failure to take it off throws here and the
  // remove below does not run.
  dropLink(rootLink);
  rmSync(scratch, { recursive: true, force: true });
});

/** An environment of a process, by name. */
type Environment = Record<string, string | undefined>;

/**
 * The environment of this process without any `COMPOSE_*`, whatever the case
 * of the names, taken name by name: the base of every run of the gate here.
 */
function baseEnv(): Environment {
  const env: Environment = {};
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith("COMPOSE_")) continue;
    env[name] = process.env[name];
  }
  return env;
}

/**
 * The environment of this process with `PATH` on an empty directory (and no
 * `PATHEXT` on Windows), whatever the case of their names there.
 */
function withoutDocker(): Environment {
  const env: Environment = {};
  for (const [name, value] of Object.entries(baseEnv())) {
    if (["PATH", "PATHEXT"].includes(name.toUpperCase())) continue;
    env[name] = value;
  }
  const empty = mkdtempSync(join(scratch, "path-"));
  env.PATH = empty;
  if (process.platform === "win32") env.PATHEXT = "";
  return env;
}

function gate(preload: string[], env: Environment = baseEnv()) {
  return spawnSync(process.execPath, [...preload, SCRIPT], {
    encoding: "utf8",
    env,
    timeout: TIMEOUT_MS,
  });
}

/** What `--variables` prints for the stack of this repository. */
const VARIABLES = {
  APP_VERSION: {
    Name: "APP_VERSION",
    DefaultValue: "",
    PresenceValue: "",
    Required: false,
  },
  GIT_COMMIT: {
    Name: "GIT_COMMIT",
    DefaultValue: "",
    PresenceValue: "",
    Required: false,
  },
  WEB_PORT: {
    Name: "WEB_PORT",
    DefaultValue: "3000",
    PresenceValue: "",
    Required: false,
  },
};
const VARS = JSON.stringify(VARIABLES);

/** What a Compose that keeps `create_host_path: false` prints for the probe. */
const PROBE_KEPT = JSON.stringify({
  services: {
    probe: { volumes: [{ type: "bind", bind: { create_host_path: false } }] },
  },
});

describe("check-compose before the configuration", () => {
  it("names a docker CLI missing from PATH", () => {
    const result = gate([], withoutDocker());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker CLI is not on PATH");
    expect(result.stderr).not.toContain("compose config failed");
  });

  it("takes a failure of docker without a code for a broken Compose file", () => {
    const module = join(scratch, "no-code.preload.mjs");
    writeFileSync(
      module,
      [
        'import cp from "node:child_process";',
        'import { syncBuiltinESMExports } from "node:module";',
        "cp.execFileSync = () => {",
        '  throw new Error("docker failed: injected");',
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );

    const result = gate(["--import", pathToFileURL(module).href]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("compose config failed");
    expect(result.stderr).toContain("docker failed: injected");
    expect(result.stderr).not.toContain("not on PATH");
  });
});

/**
 * The environment docker gets, run as CI runs the gate: a module preloaded
 * into the child in place of `execFileSync` writes down the names of the
 * environment of each call - the environment of the process for a call
 * given none, as Node runs it - answers the probe and the variables, and fails
 * the render of the stack - the run ends there, having made every call whose
 * environment is in question.
 */
describe("check-compose in the environment of its shell", () => {
  /** The calls of a run: the arguments and the names of the environment. */
  function recorded(env: Environment): {
    status: number | null;
    stderr: string;
    calls: { args: string[]; env: string[] }[];
  } {
    const dir = mkdtempSync(join(scratch, "env-"));
    const log = join(dir, "calls.jsonl");
    const module = join(dir, "record.preload.mjs");
    writeFileSync(
      module,
      [
        'import cp from "node:child_process";',
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "cp.execFileSync = (_cmd, args, options) => {",
        `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.keys(options.env ?? process.env) }) + "\\n");`,
        `  if (args.includes("--variables")) return ${JSON.stringify(VARS)};`,
        `  if (args.some((arg) => arg.endsWith("probe.yaml"))) return ${JSON.stringify(PROBE_KEPT)};`,
        '  throw new Error("render: injected");',
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const result = gate(["--import", pathToFileURL(module).href], env);
    const calls = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as { args: string[]; env: string[] })
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  }

  it("fails before docker runs when COMPOSE_FILE is set in its shell, naming it", () => {
    const { status, stderr, calls } = recorded({
      ...baseEnv(),
      COMPOSE_FILE: "deploy/other-stack.yml",
    });

    expect(status).toBe(1);
    expect(stderr).toContain(
      "check-compose: COMPOSE_FILE is set in the environment of the gate - docker compose up from this shell would bring up another stack than the one checked",
    );
    expect(stderr).not.toContain("other-stack");
    expect(calls).toEqual([]);
  });

  it("fails before docker runs when COMPOSE_PROJECT_NAME is set in its shell, naming it", () => {
    // Not one of the three that pick files, profiles and env files: any
    // COMPOSE_* outside HARMLESS (C15, E0-12K).
    const { status, stderr, calls } = recorded({
      ...baseEnv(),
      COMPOSE_PROJECT_NAME: "x",
    });

    expect(status).toBe(1);
    expect(stderr).toContain(
      "check-compose: COMPOSE_PROJECT_NAME is set in the environment of the gate - docker compose up from this shell would bring up another stack than the one checked",
    );
    expect(calls).toEqual([]);
  });

  it("renders the same with a variable of the Compose files in its shell as without it", () => {
    const without = recorded(baseEnv());
    const withVariable = recorded({
      ...baseEnv(),
      WEB_PORT: "0.0.0.0:5432",
      COMPOSE_ANSI: "never",
    });

    // The probe, the variables, the render that fails.
    expect(without.calls).toHaveLength(3);
    expect(withVariable.calls).toHaveLength(3);
    expect(withVariable.calls[2]?.env).toEqual(without.calls[2]?.env);
    // The render of the stack, each argument written out; the empty env file
    // lies in the scratch directory of its own run.
    const render = [
      "compose",
      "--env-file",
      expect.stringMatching(/sf-check-compose-[^\\/]+[\\/]empty\.env$/),
      "-f",
      join(realpathSync.native(repoRoot), "compose.yaml"),
      "--profile",
      "*",
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ];
    expect(without.calls[2]?.args).toEqual(render);
    expect(withVariable.calls[2]?.args).toEqual(render);
    const names = withVariable.calls.flatMap((call) =>
      call.env.map((name) => name.toUpperCase()),
    );
    expect(names).not.toContain("COMPOSE_ANSI");
    expect(
      withVariable.calls[2]?.env.map((name) => name.toUpperCase()),
    ).not.toContain("WEB_PORT");
    expect(withVariable.stderr).toContain("render: injected");
  });
});

/**
 * The glue of the gate, through `main` with a stand-in for `docker compose`:
 * the flags and the environment of every call, the order of the calls, the
 * files the rules get to read (rules 11, 12, 14 and 15), the scratch
 * directory gone on every exit, and one text per failure.
 */
describe("check-compose main", () => {
  /** The root as the gate sees it: through the native realpath. */
  const ROOT = realpathSync.native(repoRoot);
  /** The root compose.yaml the gate renders. */
  const ROOT_FILE = join(ROOT, "compose.yaml");
  /** A stack the rules pass, at the root of this repository. */
  function cleanAtRoot() {
    return cleanStack({ context: ROOT, envFile: join(ROOT, ".env") });
  }
  const CLEAN = JSON.stringify(cleanAtRoot());
  /** The files the rules read of a clean project at the root. */
  const cleanRead = (path: string): string | null =>
    cleanFilesAt(ROOT)[path] ?? null;

  /** What Docker Compose v2.38 prints for the probe. */
  const PROBE_LOST = JSON.stringify({
    services: { probe: { volumes: [{ type: "bind", bind: {} }] } },
  });
  /** A stack with one service built from the root. */
  const STACK = JSON.stringify({
    services: {
      api: {
        build: { context: ROOT, dockerfile: "infra/docker/app.Dockerfile" },
      },
    },
  });

  /** A docker that answers each call in turn; an Error answer is thrown. */
  function compose(...answers: (string | Error)[]) {
    let call = 0;
    return vi.fn((args: string[], _env: Environment): string => {
      const answer = answers[call];
      call += 1;
      if (answer === undefined)
        throw new Error(`unexpected call ${args.join(" ")}`);
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }

  /** The answers of a run that reaches the rules: the two renders are `stack`. */
  function through(stack: string, controlled: string = stack) {
    return compose(PROBE_KEPT, VARS, stack, controlled);
  }

  /** The environment of a run, unless a case gives its own. */
  const ENV: Environment = { PATH: "/usr/bin", DOCKER_HOST: "tcp://docker" };

  function run(
    docker: ReturnType<typeof compose>,
    read: (path: string) => string | null = () => null,
    argv: string[] = [],
    realpath?: (path: string) => string,
    env: Environment = ENV,
    platform = "linux",
  ) {
    const out: string[] = [];
    const lines: string[] = [];
    const code = main(argv, {
      compose: docker,
      read,
      ...(realpath === undefined ? {} : { realpath }),
      env,
      platform,
      out: (line) => {
        out.push(line);
        lines.push(line);
      },
      err: (line) => lines.push(line),
    });
    return { code, out, text: lines.join("\n") };
  }

  /** The file each call of `docker` was given with `-f`. */
  function filesOf(docker: ReturnType<typeof compose>) {
    return docker.mock.calls.map(([args]) => args[args.indexOf("-f") + 1]);
  }

  /** The scratch directory of a run: where its empty env file was. */
  function scratchOf(docker: ReturnType<typeof compose>): string {
    const args = docker.mock.calls[0]?.[0] ?? [];
    const envFile = args[args.indexOf("--env-file") + 1];
    if (envFile === undefined)
      throw new Error("no --env-file in the first call");
    return dirname(envFile);
  }

  /** The env file of each call, read while it ran, and its arguments. */
  function recording(...answers: string[]) {
    const envFiles: string[] = [];
    const docker = compose(...answers);
    const answer = docker.getMockImplementation();
    docker.mockImplementation((args: string[], env: Environment) => {
      envFiles.push(
        readFileSync(args[args.indexOf("--env-file") + 1] ?? "", "utf8"),
      );
      return answer?.(args, env) ?? "";
    });
    return { docker, envFiles };
  }

  it("calls the probe, the variables, the render and the control render, in that order, every profile on", () => {
    const { docker, envFiles } = recording(PROBE_KEPT, VARS, CLEAN, CLEAN);

    const { code } = run(docker, cleanRead);

    expect(code).toBe(0);
    expect(docker).toHaveBeenCalledTimes(4);
    const [probe, variables, render, control] = docker.mock.calls.map(
      ([args]) => args,
    );
    const env = (args: string[] | undefined) =>
      args?.[args.indexOf("--env-file") + 1];
    expect(probe?.[3]).toMatch(/probe\.yaml$/);
    expect(probe?.slice(4)).toEqual([
      "--profile",
      "*",
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ]);
    expect(variables).toEqual([
      "--env-file",
      env(probe),
      "-f",
      ROOT_FILE,
      "--profile",
      "*",
      "config",
      "--variables",
      "--format",
      "json",
    ]);
    expect(render).toEqual([
      "--env-file",
      env(probe),
      "-f",
      ROOT_FILE,
      "--profile",
      "*",
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ]);
    expect(control).toEqual([
      "--env-file",
      join(scratchOf(docker), "control.env"),
      ...(render ?? []).slice(2),
    ]);
    expect(envFiles).toEqual([
      "",
      "",
      "",
      // A control value for each variable docker named, in its order.
      Object.keys(VARIABLES)
        .map((name) => `${name}=${INTERPOLATED.get(name)?.control}\n`)
        .join(""),
    ]);
  });

  it("gives docker the environment without COMPOSE_* and, for the renders, without the variables of the stack", () => {
    const docker = through(CLEAN);
    const env: Environment = {
      PATH: "/usr/bin",
      DOCKER_HOST: "tcp://docker",
      COMPOSE_ANSI: "never",
      WEB_PORT: "0.0.0.0:5432",
      APP_VERSION: "1.2.3",
      compose_file: "lower.yml",
    };

    const { code } = run(docker, cleanRead, [], undefined, env);

    expect(code).toBe(0);
    expect(docker).toHaveBeenCalledTimes(4);
    const envs = docker.mock.calls.map(([, given]) => given);
    // The probe and the variables: no COMPOSE_*; on Linux a name in another
    // case is another variable, which Compose does not read.
    const kept = {
      PATH: "/usr/bin",
      DOCKER_HOST: "tcp://docker",
      compose_file: "lower.yml",
    };
    expect(envs[0]).toEqual({
      ...kept,
      WEB_PORT: "0.0.0.0:5432",
      APP_VERSION: "1.2.3",
    });
    expect(envs[1]).toEqual(envs[0]);
    expect(envs[2]).toEqual(kept);
    expect(envs[3]).toEqual(kept);
  });

  it("compares the names without their case on Windows", () => {
    const docker = through(CLEAN);
    const env: Environment = {
      Path: "C:\\Windows",
      Compose_Ansi: "never",
      web_port: "0.0.0.0:5432",
      Docker_Host: "npipe://docker",
    };

    const { code } = run(docker, cleanRead, [], undefined, env, "win32");

    expect(code).toBe(0);
    expect(docker).toHaveBeenCalledTimes(4);
    expect(docker.mock.calls[0]?.[1]).toEqual({
      Path: "C:\\Windows",
      web_port: "0.0.0.0:5432",
      Docker_Host: "npipe://docker",
    });
    expect(docker.mock.calls[2]?.[1]).toEqual({
      Path: "C:\\Windows",
      Docker_Host: "npipe://docker",
    });
  });

  it.each(["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"])(
    "fails before docker runs when %s is set, naming it without its value",
    (name) => {
      const docker = compose();

      const { code, text } = run(docker, cleanRead, [], undefined, {
        ...ENV,
        [name]: "secret-looking-value",
      });

      expect(code).toBe(1);
      expect(docker).toHaveBeenCalledTimes(0);
      expect(text).toBe(
        `check-compose: ${name} is set in the environment of the gate - docker compose up from this shell would bring up another stack than the one checked; unset it and run the gate again (its value is not printed)`,
      );
    },
  );

  it.each([
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_DISABLE_ENV_FILE",
    "COMPOSE_PATH_SEPARATOR",
    "COMPOSE_NOT_YET_KNOWN",
  ])(
    "fails before docker runs when %s is set - a COMPOSE_* outside HARMLESS",
    (name) => {
      const docker = compose();

      const { code, text } = run(docker, cleanRead, [], undefined, {
        ...ENV,
        [name]: "secret-looking-value",
      });

      expect(code).toBe(1);
      expect(docker).toHaveBeenCalledTimes(0);
      expect(text).toBe(
        `check-compose: ${name} is set in the environment of the gate - docker compose up from this shell would bring up another stack than the one checked; unset it and run the gate again (its value is not printed)`,
      );
    },
  );

  it.each([
    "COMPOSE_ANSI",
    "COMPOSE_PROGRESS",
    "COMPOSE_STATUS_STDOUT",
    "COMPOSE_MENU",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_IGNORE_ORPHANS",
    "COMPOSE_REMOVE_ORPHANS",
  ])(
    "runs with %s set - it changes how Compose prints, not the stack",
    (name) => {
      const linux = through(CLEAN);
      const windows = through(CLEAN);
      const mixed = `${name.slice(0, 1)}${name.slice(1).toLowerCase()}`;

      const onLinux = run(linux, cleanRead, [], undefined, {
        ...ENV,
        [name]: "1",
      });
      const onWindows = run(
        windows,
        cleanRead,
        [],
        undefined,
        { ...ENV, [mixed]: "1" },
        "win32",
      );

      expect(onLinux.code).toBe(0);
      expect(onWindows.code).toBe(0);
      // Out of the environment of docker all the same.
      expect(linux.mock.calls.map(([, given]) => given)).toEqual(
        Array.from({ length: 4 }, () => ENV),
      );
      expect(windows.mock.calls.map(([, given]) => given)).toEqual(
        Array.from({ length: 4 }, () => ENV),
      );
    },
  );

  it("takes an empty COMPOSE_PROJECT_NAME for one not set", () => {
    const docker = through(CLEAN);

    const { code } = run(docker, cleanRead, [], undefined, {
      ...ENV,
      COMPOSE_PROJECT_NAME: "",
    });

    expect(code).toBe(0);
    expect(docker).toHaveBeenCalledTimes(4);
  });

  it("takes Compose_File for COMPOSE_FILE on Windows, and not elsewhere", () => {
    const env = { ...ENV, Compose_File: "x.yml" };

    const windows = run(compose(), cleanRead, [], undefined, env, "win32");
    const linux = run(through(CLEAN), cleanRead, [], undefined, env, "linux");

    expect(windows.code).toBe(1);
    expect(windows.text).toContain("check-compose: Compose_File is set");
    expect(linux.code).toBe(0);
  });

  it("takes an empty COMPOSE_FILE for one not set", () => {
    const docker = through(CLEAN);

    const { code } = run(docker, cleanRead, [], undefined, {
      ...ENV,
      COMPOSE_FILE: "",
    });

    expect(code).toBe(0);
    expect(docker).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["win32", 0],
    ["linux", 1],
  ])(
    "hands the rules its platform (%s) for the case of a path of the graph",
    (platform, exit) => {
      // Windows opens Infra\docker-compose.yml as infra\docker-compose.yml;
      // the rules compare the paths the way the platform of the gate does,
      // not the one the tests run on (C10, E0-12K).
      const infra = join(ROOT, "infra", "docker-compose.yml");
      const written = join(ROOT, "Infra", "docker-compose.yml");
      const files: Record<string, string> = {
        ...cleanFilesAt(ROOT),
        [ROOT_FILE]: CLEAN_ROOT_COMPOSE.replace(
          "  - infra/docker-compose.yml",
          "  - Infra/docker-compose.yml",
        ),
      };
      const realpath = realpathIn(files, {
        [repoRoot]: ROOT,
        [written]: infra,
      });

      const { code, text } = run(
        through(CLEAN),
        (path) => files[path] ?? null,
        [ROOT_FILE],
        realpath,
        ENV,
        platform,
      );

      expect(code).toBe(exit);
      if (exit === 1) expect(text).toContain(`include[0] names ${written}`);
    },
  );

  it("gives the rules the .dockerignore of each build, the root .env.test and the root Compose file", () => {
    const read = vi.fn((_path: string): string | null => null);

    const { code, text } = run(through(STACK), read);

    expect(code).toBe(1);
    // Rule 11 looks for the Dockerfile's own .dockerignore first, then reads
    // the one of the context; rule 12 reads .env.test; the graph starts at
    // compose.yaml, which this reader does not have, when rule 14 asks for
    // it. Nothing else.
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls).toEqual([
      [join(ROOT, "infra", "docker", "app.Dockerfile.dockerignore")],
      [join(ROOT, ".dockerignore")],
      [join(ROOT, ".env.test")],
      [ROOT_FILE],
    ]);
    expect(text).toContain(`api: no ${join(ROOT, ".dockerignore")}`);
    expect(text).toContain(`${join(ROOT, ".env.test")}: missing`);
    expect(text).toContain(`${ROOT_FILE}: not a file`);
  });

  it("passes a clean stack: exit 0, check-compose: clean, no scratch left", () => {
    const docker = through(CLEAN);

    const { code, out, text } = run(docker, cleanRead);

    expect(text).toBe("check-compose: clean");
    expect(out).toEqual(["check-compose: clean"]);
    expect(code).toBe(0);
    expect(existsSync(scratchOf(docker))).toBe(false);
  });

  it("fails a stack with a single violation", () => {
    const one = cleanAtRoot();
    one.services.web = { ...one.services.web, restart: "no" };
    const broken = JSON.stringify(one);

    const { code, out, text } = run(through(broken), cleanRead);

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(text).toBe(
      [
        `check-compose: ${ROOT_FILE}`,
        '  web: restart is not "unless-stopped" - it would stay down after a reboot',
      ].join("\n"),
    );
  });

  /** A realpath of the real disk that also finds `extra` (path -> target). */
  function diskWith(extra: Record<string, string>) {
    return (path: string): string => extra[path] ?? realpathSync.native(path);
  }

  it("fails an override at the root (rule 14), found by the realpath of the gate", () => {
    const override = join(ROOT, "docker-compose.override.yml");

    const { code, text } = run(
      through(CLEAN),
      cleanRead,
      [],
      diskWith({ [override]: override }),
    );

    expect(code).toBe(1);
    expect(text).toBe(
      [
        `check-compose: ${ROOT_FILE}`,
        `  ${override}: Compose merges it into the stack when run without -f from ${ROOT}, and the gate renders with -f - an override is not supported, change the Compose files of the stack instead`,
      ].join("\n"),
    );
  });

  it("fails an include of a file outside the files of the gate (rule 15)", () => {
    const extra = join(ROOT, "deploy", "extra.yml");
    const read = (path: string): string | null => {
      if (path === ROOT_FILE)
        return `${CLEAN_ROOT_COMPOSE}  - deploy/extra.yml\n`;
      if (path === extra) return "services: {}\n";
      return cleanRead(path);
    };

    const { code, text } = run(
      through(CLEAN),
      read,
      [],
      diskWith({ [extra]: extra }),
    );

    expect(code).toBe(1);
    expect(text).toContain(
      `  ${ROOT_FILE}: include[2] names ${extra} - not one of the Compose files the gate is chosen on`,
    );
  });

  it("fails a variable that lands outside its fields in the control render", () => {
    const controlled = cleanAtRoot();
    const port = INTERPOLATED.get("WEB_PORT")?.control;
    controlled.services.postgres = {
      ...controlled.services.postgres,
      ports: [{ host_ip: "127.0.0.1", target: 5432, published: port }],
    };

    const { code, text } = run(
      through(CLEAN, JSON.stringify(controlled)),
      cleanRead,
    );

    expect(code).toBe(1);
    expect(text).toBe(
      [
        `check-compose: ${ROOT_FILE}`,
        "  interpolation: services.postgres.ports[0].published takes WEB_PORT - it may land only in services.web.ports[*].host_ip, services.web.ports[*].published",
      ].join("\n"),
    );
  });

  it("stops on a variable it does not know, before the stack is rendered", () => {
    const docker = compose(
      PROBE_KEPT,
      JSON.stringify({ ...VARIABLES, PG_HOST: { Required: false } }),
    );

    const { code, text } = run(docker, cleanRead);

    expect(code).toBe(1);
    expect(docker).toHaveBeenCalledTimes(2);
    expect(text).toBe(
      [
        `check-compose: ${ROOT_FILE}`,
        "  interpolation: PG_HOST - the gate has no control value for it and cannot see where it lands; add it to INTERPOLATED of scripts/compose-rules.mjs with the fields it may reach",
      ].join("\n"),
    );
  });

  it("names a file the rules could not read, and removes its scratch", () => {
    const docker = through(CLEAN);
    const denied = join(ROOT, ".env.test");
    const read = (path: string): string | null => {
      if (path !== denied) return cleanRead(path);
      throw Object.assign(
        new Error(`EACCES: permission denied, open '${path}'`),
        { code: "EACCES" },
      );
    };

    const { code, text } = run(docker, read);

    expect(code).toBe(1);
    expect(text).toBe(
      [
        `check-compose: cannot read ${denied}, a file the rules check`,
        `EACCES: permission denied, open '${denied}'`,
      ].join("\n"),
    );
    expect(existsSync(scratchOf(docker))).toBe(false);
  });

  it("names a path the rules could not resolve for another reason than its absence", () => {
    const override = join(ROOT, "compose.override.yml");
    const realpath = (path: string): string => {
      if (path !== override) return realpathSync.native(path);
      throw Object.assign(new Error(`EACCES: realpath '${path}'`), {
        code: "EACCES",
      });
    };

    const { code, text } = run(through(CLEAN), cleanRead, [], realpath);

    expect(code).toBe(1);
    expect(text).toBe(
      [
        `check-compose: cannot read ${override}, a file the rules check`,
        `EACCES: realpath '${override}'`,
      ].join("\n"),
    );
  });

  /**
   * A root the realpath of this run spells otherwise than `repoRoot`: the
   * side the gate must build everything from - the `-f` file, the `.env` of
   * rule 10, the `.env.test` of rule 12, the graph of rules 14 and 15 - is
   * the canonical one.
   */
  const CANONICAL = resolve("/Canonical-Checkout");
  const CANONICAL_FILE = join(CANONICAL, "compose.yaml");
  const CANONICAL_INFRA = [
    join(CANONICAL, "infra", "docker-compose.yml"),
    join(CANONICAL, "infra", "docker-compose.app.yml"),
  ];
  const canonicalStack = JSON.stringify(
    cleanStack({ context: CANONICAL, envFile: join(CANONICAL, ".env") }),
  );
  const canonicalRead = vi.fn(
    (path: string): string | null => cleanFilesAt(CANONICAL)[path] ?? null,
  );

  /**
   * A realpath that knows `spellings` (path -> canonical path) and the files
   * of the graph under the canonical root; any other path is not there -
   * `realpathIn` of the fixture, with `spellings` for its links.
   */
  function realpathOf(spellings: Record<string, string>) {
    const graph = Object.fromEntries(CANONICAL_INFRA.map((path) => [path, ""]));
    return realpathIn(graph, spellings);
  }

  it("builds the file, .env, .env.test and the graph from the canonical root", () => {
    canonicalRead.mockClear();
    const docker = through(canonicalStack);
    const realpath = realpathOf({
      [ROOT_FILE]: CANONICAL_FILE,
      [repoRoot]: CANONICAL,
    });

    const { code, text } = run(docker, canonicalRead, [ROOT_FILE], realpath);

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker).slice(1)).toEqual([
      CANONICAL_FILE,
      CANONICAL_FILE,
      CANONICAL_FILE,
    ]);
    // Every read under the canonical root, in the order of the rules: the
    // two files of rule 11 for each of the four builds - targets of one
    // Dockerfile - .env.test (rule 12) and the three files of the graph,
    // read when rule 14 asks for it.
    const dockerfileIgnore = join(
      CANONICAL,
      "infra",
      "docker",
      "app.Dockerfile.dockerignore",
    );
    const contextIgnore = join(CANONICAL, ".dockerignore");
    const expected = [
      ...["migrate", "api", "worker", "web"].flatMap(() => [
        dockerfileIgnore,
        contextIgnore,
      ]),
      join(CANONICAL, ".env.test"),
      CANONICAL_FILE,
      ...CANONICAL_INFRA,
    ];
    expect(canonicalRead).toHaveBeenCalledTimes(expected.length);
    expect(canonicalRead.mock.calls.map(([path]) => path)).toEqual(expected);
  });

  it("takes the root under another case of its letters for the root", () => {
    // Windows ignores the case, a string comparison would not: the gate
    // compares what the realpath gives, here one that canonicalizes the case
    // on every platform.
    const spelled = CANONICAL_FILE.replace(/[a-z]/gi, (letter) =>
      letter === letter.toLowerCase()
        ? letter.toUpperCase()
        : letter.toLowerCase(),
    );
    const docker = through(canonicalStack);
    const realpath = realpathOf({
      [spelled]: CANONICAL_FILE,
      [repoRoot]: CANONICAL,
    });

    const { code, text } = run(docker, canonicalRead, [spelled], realpath);

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker)[2]).toBe(CANONICAL_FILE);
  });

  it("names the root when the root cannot be resolved", () => {
    const docker = compose();
    const realpath = realpathOf({ [ROOT_FILE]: ROOT_FILE });

    const { code, text } = run(docker, cleanRead, [ROOT_FILE], realpath);

    expect(code).toBe(1);
    expect(docker).toHaveBeenCalledTimes(0);
    expect(text).toContain(
      `check-compose: cannot resolve the root of the repository ${repoRoot}`,
    );
    expect(text).not.toContain("cannot resolve the Compose file");
  });

  it("follows a link to the root, and builds .env from where it leads", () => {
    // A junction, a subst drive or a symlink: realpath resolves it, and
    // Compose gets the path the mount of .env is resolved against.
    const alias = resolve("/linked-checkout/compose.yaml");
    const docker = through(CLEAN);

    const { code, text } = run(
      docker,
      cleanRead,
      [alias],
      diskWith({ [alias]: ROOT_FILE, [repoRoot]: ROOT }),
    );

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker)[2]).toBe(ROOT_FILE);
  });

  it("follows a real junction to the root by the native realpath when none is given", () => {
    // No `deps.realpath`: the default of `canonical` resolves the link on
    // disk, a junction on Windows and a symlink elsewhere.
    const docker = through(CLEAN);
    symlinkSync(ROOT, rootLink, "junction");
    const outcome: { failure?: { error: unknown } } = {};
    try {
      const { code, text } = run(docker, cleanRead, [
        join(rootLink, "compose.yaml"),
      ]);

      expect(text).toBe("check-compose: clean");
      expect(code).toBe(0);
      expect(filesOf(docker)[2]).toBe(ROOT_FILE);
    } catch (error) {
      outcome.failure = { error };
    }
    // Off before anything removes the scratch directory. A failure of the
    // unlink does not hide a failed assertion (it is thrown after it);
    // `afterAll` tries again and stops before the recursive remove if the
    // link still stands.
    let unlinkError: { error: unknown } | undefined;
    try {
      dropLink(rootLink);
    } catch (error) {
      unlinkError = { error };
    }
    if (outcome.failure) throw outcome.failure.error;
    if (unlinkError) throw unlinkError.error;
    expect(existsSync(rootLink)).toBe(false);
  });

  it("refuses a file it cannot resolve, before docker runs", () => {
    const docker = compose();
    const missing = join(ROOT, "no-such-compose.yaml");

    const { code, text } = run(docker, cleanRead, [missing]);

    expect(code).toBe(1);
    expect(docker).toHaveBeenCalledTimes(0);
    expect(text).toContain(
      `check-compose: cannot resolve the Compose file ${missing}`,
    );
  });

  it("prints the failure of the realpath itself under the header", () => {
    const docker = compose();
    const realpath = (path: string): string => {
      throw new Error(`EACCES: realpath ${path}`);
    };

    const { code, text } = run(docker, cleanRead, [ROOT_FILE], realpath);

    expect(code).toBe(1);
    expect(text).toContain(
      `check-compose: cannot resolve the Compose file ${ROOT_FILE}
EACCES: realpath ${ROOT_FILE}`,
    );
  });

  it("removes its scratch directory after each failure", () => {
    const runs = [
      through(STACK),
      compose(new Error("probe: injected")),
      compose(PROBE_LOST, new Error("version: injected")),
      compose(PROBE_KEPT, new Error("variables: injected")),
      compose(PROBE_KEPT, VARS, new Error("stack: injected")),
      compose(PROBE_KEPT, VARS, CLEAN, new Error("control: injected")),
    ];

    for (const docker of runs) {
      expect(run(docker).code).toBe(1);
      expect(existsSync(scratchOf(docker))).toBe(false);
    }
  });

  /**
   * A call of docker that ran and failed, the way `execFileSync` throws it:
   * the exit code, the stderr, and a message that repeats the stderr.
   */
  function exited(stderr: string): Error {
    return Object.assign(
      new Error(`Command failed: docker compose config\n${stderr}`),
      { status: 15, signal: null, stdout: "", stderr },
    );
  }

  /** A value out of `.env`, the way Compose quotes it back on stderr. */
  const ENV_VALUE = "sk-secret-value";

  it.each([
    ["the rendering probe", () => compose(exited(`invalid "${ENV_VALUE}"`))],
    ["the variables", () => compose(PROBE_KEPT, exited(`KEY=${ENV_VALUE}`))],
    [
      "the root file",
      () =>
        compose(
          PROBE_KEPT,
          VARS,
          exited(`variable 'API_KEY' is "${ENV_VALUE}"
KEY=${ENV_VALUE}`),
        ),
    ],
    [
      "the control render",
      () => compose(PROBE_KEPT, VARS, CLEAN, exited(`KEY=${ENV_VALUE}`)),
    ],
    ["the version", () => compose(PROBE_LOST, exited(`KEY=${ENV_VALUE}`))],
  ])(
    "prints nothing docker wrote when %s fails, only how it ended",
    (_call, docker) => {
      const { code, text } = run(docker(), cleanRead);

      expect(code).toBe(1);
      expect(text).not.toContain(ENV_VALUE);
      expect(text).not.toContain("Command failed");
      expect(text).toContain("docker compose exited with code 15");
    },
  );

  it("gives the command of a failed root file with a placeholder for the env file of the gate", () => {
    const docker = compose(PROBE_KEPT, VARS, exited(`KEY=${ENV_VALUE}`));

    const { text } = run(docker, cleanRead);

    // The scratch directory is gone by the time anyone reads this; the
    // command names nothing in it.
    expect(text).not.toContain(scratchOf(docker));
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f ${shellWord(ROOT_FILE)} --profile '*' config --no-env-resolution --format json
  (create an empty file and pass its path as --env-file)`,
    );
    expect(text).not.toContain("gone by now");
  });

  it("gives the command of failed variables with a placeholder for the env file of the gate", () => {
    const { text } = run(compose(PROBE_KEPT, exited("broken")), cleanRead);

    expect(text).toContain(
      `check-compose: docker compose config --variables failed for ${ROOT_FILE}`,
    );
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f ${shellWord(ROOT_FILE)} --profile '*' config --variables --format json
  (create an empty file and pass its path as --env-file)`,
    );
  });

  it("gives the command of a failed control render with a placeholder for its env file", () => {
    const docker = compose(PROBE_KEPT, VARS, CLEAN, exited("broken"));

    const { text } = run(docker, cleanRead);

    expect(text).toContain(
      `check-compose: docker compose config failed for ${ROOT_FILE} with the control values of its variables`,
    );
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<control env file>' -f ${shellWord(ROOT_FILE)} --profile '*' config --no-env-resolution --format json
  (pass as --env-file a file with NAME=control for each variable of INTERPOLATED in scripts/compose-rules.mjs)`,
    );
    expect(text).not.toContain(scratchOf(docker));
  });

  /**
   * The path as the gate writes it in the command: bare when it holds only
   * `[\w./:-]`, else in single quotes (the rule of `shellArg`).
   */
  function shellWord(path: string): string {
    return /[^\w./:-]/.test(path) ? `'${path}'` : path;
  }

  /**
   * The text of a run whose root file is `file` - a path the realpath of the
   * run gives as it is - and whose render fails.
   */
  function failedAt(file: string): string {
    const docker = compose(PROBE_KEPT, VARS, exited("broken"));
    const realpath = (path: string): string => {
      if (path === resolve(file)) return file;
      if (path === repoRoot) return posix.dirname(file);
      throw new Error(`unexpected realpath ${path}`);
    };
    return run(docker, cleanRead, [file], realpath).text;
  }

  it("quotes an argument of the command with a space, a dollar or a backquote in it, so no shell expands them", () => {
    const file = posix.join('/Odd "checkout" $HOME `x` root', "compose.yaml");

    // In single quotes neither a POSIX shell nor PowerShell expands anything.
    expect(failedAt(file)).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f '${file}' --profile '*' config --no-env-resolution --format json\n`,
    );
  });

  it("quotes a bare path with backslashes in it, so a POSIX shell keeps them", () => {
    // No space, no dollar: only the backslashes of a Windows path.
    const spelled = process.platform === "win32" ? "D:\\x" : "/D:\\x";
    const file = join(spelled, "compose.yaml");
    const docker = compose(PROBE_KEPT, VARS, exited("broken"));
    const realpath = (path: string): string => {
      if (path === resolve(file)) return file;
      if (path === repoRoot) return spelled;
      throw new Error(`unexpected realpath ${path}`);
    };

    const { text } = run(docker, cleanRead, [file], realpath);

    expect(file).toContain("\\");
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f '${file}' --profile '*' config --no-env-resolution --format json\n`,
    );
  });

  it.each([",", "@", "%", "+"])("quotes a path with %s in it", (character) => {
    // A literal path on every platform: what the gate prints is compared
    // with what is written here, not with a copy of its rule.
    const file = `/a${character}b/compose.yaml`;

    expect(failedAt(file)).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f '/a${character}b/compose.yaml' --profile '*' config --no-env-resolution --format json\n`,
    );
  });

  it("writes a single quote of an argument the POSIX way and says so on a line of its own", () => {
    const file = posix.join("/O'Brien checkout", "compose.yaml");

    const text = failedAt(file);

    expect(text).toContain(
      `-f '/O'\\''Brien checkout/compose.yaml' --profile '*' config --no-env-resolution --format json\n  (POSIX sh quoting)\n`,
    );
    const commandLine = text
      .split("\n")
      .find((line) => line.startsWith("  to read it, run: "));
    expect(commandLine).toBeDefined();
    expect(commandLine).not.toContain("POSIX sh quoting");
  });

  it("gives no command for a failed probe, only how it ended and where to look", () => {
    const docker = compose(exited(`KEY=${ENV_VALUE}`));

    const { code, text } = run(docker, cleanRead);

    expect(code).toBe(1);
    expect(text).toContain(
      "  the rendering probe built into the gate failed: docker compose exited with code 15; run `docker compose version`",
    );
    expect(text).not.toContain("to read it, run:");
    expect(text).not.toContain(scratchOf(docker));
    expect(text).not.toContain("probe.yaml");
    expect(text).not.toContain(tmpdir());
  });

  it("gives the command of a failed version as it ran, without .env in the reason", () => {
    const { text } = run(compose(PROBE_LOST, exited("broken")), cleanRead);

    // `docker compose version` interpolates no `.env`.
    expect(text).toContain(
      "  docker compose exited with code 15; what it printed is not repeated here\n  to read it, run: docker compose version --short",
    );
    expect(text).not.toContain("values from .env");
  });

  it("tells a call the gate itself ended on ENOBUFS from a signal, with no command to repeat", () => {
    // How `execFileSync` throws it: Node ends the call with SIGTERM.
    const limited = Object.assign(
      new Error(`spawnSync docker ENOBUFS\nKEY=${ENV_VALUE}`),
      {
        code: "ENOBUFS",
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      },
    );

    const { code: exit, text } = run(
      compose(PROBE_KEPT, VARS, limited),
      cleanRead,
    );

    expect(exit).toBe(1);
    expect(text).toContain(
      "  docker compose printed more than the gate reads (ENOBUFS) - a limit of this gate, not a fault of the Compose files; what it printed is not repeated here",
    );
    expect(text).not.toContain("SIGTERM");
    expect(text).not.toContain("to read it, run:");
    expect(text).not.toContain(ENV_VALUE);
  });

  it("names the signal that ended docker", () => {
    const ended = Object.assign(
      new Error(`Command failed: docker compose config
KEY=${ENV_VALUE}`),
      { status: null, signal: "SIGTERM", stdout: "", stderr: ENV_VALUE },
    );

    const { code, text } = run(compose(PROBE_KEPT, VARS, ended), cleanRead);

    expect(code).toBe(1);
    expect(text).toContain("docker compose was ended by SIGTERM");
    expect(text).not.toContain(ENV_VALUE);
  });

  it.each([
    ["the rendering probe", (stdout: string) => compose(stdout)],
    ["the variables", (stdout: string) => compose(PROBE_KEPT, stdout)],
    ["the root file", (stdout: string) => compose(PROBE_KEPT, VARS, stdout)],
    [
      "the control render",
      (stdout: string) => compose(PROBE_KEPT, VARS, CLEAN, stdout),
    ],
  ])(
    "prints only the size of an answer to %s that is not JSON",
    (_call, docker) => {
      // `JSON.parse` quotes what it choked on, and that is docker's stdout.
      const stdout = `KEY=${ENV_VALUE}`;

      const { code, text } = run(docker(stdout), cleanRead);

      expect(code).toBe(1);
      expect(text).not.toContain(ENV_VALUE);
      expect(text).toContain(
        `  stdout is not JSON (${Buffer.byteLength(stdout, "utf8")} bytes)`,
      );
    },
  );

  it("prints why a docker that never started failed", () => {
    // No code and no stderr: the spawn itself was refused, and its message
    // carries nothing docker printed.
    const refused = Object.assign(new Error("spawnSync docker EACCES"), {
      code: "EACCES",
    });
    const { code, text } = run(compose(refused));

    expect(code).toBe(1);
    expect(text).toContain("spawnSync docker EACCES");
  });

  it("tells a failed probe from a failed version and a failed file", () => {
    const probe = run(compose(new Error("probe: injected")));
    const version = run(compose(PROBE_LOST, new Error("version: injected")));
    const file = run(compose(PROBE_KEPT, VARS, new Error("stack: injected")));

    expect(probe.code).toBe(1);
    expect(probe.text).toContain(
      "docker compose config failed for the rendering probe",
    );
    expect(probe.text).toContain("probe: injected");
    expect(version.code).toBe(1);
    expect(version.text).toContain(
      "docker compose version failed after the rendering probe failed",
    );
    expect(version.text).toContain("version: injected");
    expect(file.code).toBe(1);
    expect(file.text).toContain(
      `docker compose config failed for ${ROOT_FILE}`,
    );
    expect(file.text).toContain("stack: injected");
    for (const other of [probe.text, version.text]) {
      expect(other).not.toContain(`failed for ${ROOT_FILE}`);
    }
  });

  it("names the Compose version when the probe loses the option", () => {
    const { code, text } = run(compose(PROBE_LOST, "2.38.2\n"));

    expect(code).toBe(1);
    expect(text).toContain("check-compose: the rendering probe failed");
    expect(text).toContain("docker compose version: 2.38.2");
  });

  it("names what the probe lost when the version cannot be read either", () => {
    const { code, text } = run(
      compose(PROBE_LOST, new Error("version: injected")),
    );

    expect(code).toBe(1);
    expect(text).toContain("check-compose: the rendering probe failed");
    expect(text).toContain(
      "  this docker compose prints the probe's mount with bind has no create_host_path: false",
    );
    expect(text).toContain("version: injected");
  });

  it("refuses a file away from the root, before docker runs", () => {
    const docker = compose();

    const { code, text } = run(docker, () => null, [
      join(repoRoot, "infra", "docker-compose.app.yml"),
    ]);

    expect(code).toBe(1);
    expect(docker).toHaveBeenCalledTimes(0);
    expect(text).toContain("is not at the root of the repository");
    expect(text).toContain("check the root compose.yaml");
  });
});
