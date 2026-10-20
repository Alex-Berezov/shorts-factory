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
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/check-compose.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { cleanFilesAt, cleanStack } from "./compose-fixture.js";
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

const scratch = mkdtempSync(join(tmpdir(), "sf-check-compose-test-"));
/** A junction to the real root of the repository, made by one case only. */
const rootLink = join(scratch, "linked-checkout");
afterAll(() => {
  // The link goes first on its own: a recursive remove must never walk through
  // it into the real repository. A failure to take it off throws here and the
  // remove below does not run.
  dropLink(rootLink);
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The environment of this process with `PATH` on an empty directory (and no
 * `PATHEXT` on Windows), whatever the case of their names there.
 */
function withoutDocker(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["PATH", "PATHEXT"].includes(name.toUpperCase()),
    ),
  );
  const empty = mkdtempSync(join(scratch, "path-"));
  return process.platform === "win32"
    ? { ...env, PATH: empty, PATHEXT: "" }
    : { ...env, PATH: empty };
}

function gate(preload: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [...preload, SCRIPT], {
    encoding: "utf8",
    env,
    timeout: TIMEOUT_MS,
  });
}

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
 * The glue of the gate, through `main` with a stand-in for `docker compose`:
 * the flags of every call that keep `.env` out of the interpolation and
 * `env_file` visible, the files the rules get to read (rule 11, rule 12),
 * the scratch directory gone on every exit, and one text per failure.
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

  /** What a Compose that keeps `create_host_path: false` prints for the probe. */
  const PROBE_KEPT = JSON.stringify({
    services: {
      probe: { volumes: [{ type: "bind", bind: { create_host_path: false } }] },
    },
  });
  /** What Docker Compose v2.38 prints for it. */
  const PROBE_LOST = JSON.stringify({
    services: { probe: { volumes: [{ type: "bind", bind: {} }] } },
  });
  /** A stack with one service built from the root. */
  const STACK = JSON.stringify({
    services: {
      api: {
        build: { context: ROOT, dockerfile: "infra/docker/api.Dockerfile" },
      },
    },
  });

  /** A docker that answers each call in turn; a function answer is thrown. */
  function compose(...answers: (string | Error)[]) {
    let call = 0;
    return vi.fn((args: string[]): string => {
      const answer = answers[call];
      call += 1;
      if (answer === undefined)
        throw new Error(`unexpected call ${args.join(" ")}`);
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }

  function run(
    docker: ReturnType<typeof compose>,
    read: (path: string) => string | null = () => null,
    argv: string[] = [],
    realpath?: (path: string) => string,
  ) {
    const out: string[] = [];
    const lines: string[] = [];
    const code = main(argv, {
      compose: docker,
      read,
      ...(realpath === undefined ? {} : { realpath }),
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

  it("renders the probe, then the root file, each with the flags that keep .env out", () => {
    /** Contents of the env file each call was given, read while it ran. */
    const envFiles: string[] = [];
    const docker = compose(PROBE_KEPT, STACK);
    docker.mockImplementationOnce((args: string[]) => {
      envFiles.push(
        readFileSync(args[args.indexOf("--env-file") + 1] ?? "", "utf8"),
      );
      return PROBE_KEPT;
    });
    docker.mockImplementationOnce((args: string[]) => {
      envFiles.push(
        readFileSync(args[args.indexOf("--env-file") + 1] ?? "", "utf8"),
      );
      return STACK;
    });

    run(docker);

    expect(docker).toHaveBeenCalledTimes(2);
    const files = filesOf(docker);
    expect(files[0]).toMatch(/probe\.yaml$/);
    expect(files[1]).toBe(ROOT_FILE);
    for (const [args] of docker.mock.calls) {
      expect(args.slice(0, 1)).toEqual(["--env-file"]);
      expect(args.slice(2)).toEqual([
        "-f",
        args[3],
        "config",
        "--no-env-resolution",
        "--format",
        "json",
      ]);
    }
    expect(envFiles).toEqual(["", ""]);
  });

  it("gives the rules the .dockerignore of each build and the root .env.test", () => {
    const read = vi.fn((_path: string): string | null => null);

    const { code, text } = run(compose(PROBE_KEPT, STACK), read);

    expect(code).toBe(1);
    // Rule 11 looks for the Dockerfile's own .dockerignore first, then reads
    // the one of the context; rule 12 reads .env.test. Nothing else.
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls).toEqual([
      [join(ROOT, "infra", "docker", "api.Dockerfile.dockerignore")],
      [join(ROOT, ".dockerignore")],
      [join(ROOT, ".env.test")],
    ]);
    expect(text).toContain(`api: no ${join(ROOT, ".dockerignore")}`);
    expect(text).toContain(`${join(ROOT, ".env.test")}: missing`);
  });

  it("passes a clean stack: exit 0, check-compose: clean, no scratch left", () => {
    const docker = compose(PROBE_KEPT, CLEAN);

    const { code, out, text } = run(docker, cleanRead);

    expect(text).toBe("check-compose: clean");
    expect(out).toEqual(["check-compose: clean"]);
    expect(code).toBe(0);
    expect(existsSync(scratchOf(docker))).toBe(false);
  });

  it("fails a stack with a single violation", () => {
    const one = cleanAtRoot();
    one.services.web = { ...one.services.web, restart: "no" };

    const { code, out, text } = run(
      compose(PROBE_KEPT, JSON.stringify(one)),
      cleanRead,
    );

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(text).toBe(
      [
        `check-compose: ${ROOT_FILE}`,
        '  web: restart is not "unless-stopped" - it would stay down after a reboot',
      ].join("\n"),
    );
  });

  it("names a file the rules could not read, and removes its scratch", () => {
    const docker = compose(PROBE_KEPT, CLEAN);
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

  /**
   * A root the realpath of this run spells otherwise than `repoRoot`: the
   * side the gate must build everything from - the `-f` file, the `.env` of
   * rule 10, the `.env.test` of rule 12 - is the canonical one.
   */
  const CANONICAL = resolve("/Canonical-Checkout");
  const CANONICAL_FILE = join(CANONICAL, "compose.yaml");
  const canonicalStack = JSON.stringify(
    cleanStack({ context: CANONICAL, envFile: join(CANONICAL, ".env") }),
  );
  const canonicalRead = vi.fn(
    (path: string): string | null => cleanFilesAt(CANONICAL)[path] ?? null,
  );

  /** A realpath that knows `spellings` (path -> canonical path) and nothing else. */
  function realpathOf(spellings: Record<string, string>) {
    return (path: string): string => {
      const found = spellings[path];
      if (found === undefined) throw new Error(`ENOENT: realpath ${path}`);
      return found;
    };
  }

  it("builds the file, .env and .env.test from the canonical root", () => {
    canonicalRead.mockClear();
    const docker = compose(PROBE_KEPT, canonicalStack);
    const realpath = realpathOf({
      [ROOT_FILE]: CANONICAL_FILE,
      [repoRoot]: CANONICAL,
    });

    const { code, text } = run(docker, canonicalRead, [ROOT_FILE], realpath);

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker)[1]).toBe(CANONICAL_FILE);
    // Every read under the canonical root, each once: the files of rule 11
    // for the four builds and .env.test.
    const dockerfileIgnore = (name: string) =>
      join(CANONICAL, "infra", "docker", `${name}.Dockerfile.dockerignore`);
    const contextIgnore = join(CANONICAL, ".dockerignore");
    const expected = [
      dockerfileIgnore("migrate"),
      contextIgnore,
      dockerfileIgnore("api"),
      contextIgnore,
      dockerfileIgnore("worker"),
      contextIgnore,
      dockerfileIgnore("web"),
      contextIgnore,
      join(CANONICAL, ".env.test"),
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
    const docker = compose(PROBE_KEPT, canonicalStack);
    const realpath = realpathOf({
      [spelled]: CANONICAL_FILE,
      [repoRoot]: CANONICAL,
    });

    const { code, text } = run(docker, canonicalRead, [spelled], realpath);

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker)[1]).toBe(CANONICAL_FILE);
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
    const realpath = (path: string): string => {
      if (path === alias) return ROOT_FILE;
      if (path === repoRoot) return ROOT;
      throw new Error(`unexpected realpath ${path}`);
    };
    const docker = compose(PROBE_KEPT, CLEAN);

    const { code, text } = run(docker, cleanRead, [alias], realpath);

    expect(text).toBe("check-compose: clean");
    expect(code).toBe(0);
    expect(filesOf(docker)[1]).toBe(ROOT_FILE);
  });

  it("follows a real junction to the root by the native realpath when none is given", () => {
    // No `deps.realpath`: the default of `canonical` resolves the link on
    // disk, a junction on Windows and a symlink elsewhere.
    const docker = compose(PROBE_KEPT, CLEAN);
    symlinkSync(ROOT, rootLink, "junction");
    const outcome: { failure?: { error: unknown } } = {};
    try {
      const { code, text } = run(docker, cleanRead, [
        join(rootLink, "compose.yaml"),
      ]);

      expect(text).toBe("check-compose: clean");
      expect(code).toBe(0);
      expect(filesOf(docker)[1]).toBe(ROOT_FILE);
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
      compose(PROBE_KEPT, STACK),
      compose(new Error("probe: injected")),
      compose(PROBE_LOST, new Error("version: injected")),
      compose(PROBE_KEPT, new Error("stack: injected")),
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
    [
      "the root file",
      () =>
        compose(
          PROBE_KEPT,
          exited(`variable 'API_KEY' is "${ENV_VALUE}"
KEY=${ENV_VALUE}`),
        ),
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
    const docker = compose(PROBE_KEPT, exited(`KEY=${ENV_VALUE}`));

    const { text } = run(docker, cleanRead);

    // The scratch directory is gone by the time anyone reads this; the
    // command names nothing in it.
    expect(text).not.toContain(scratchOf(docker));
    const rootArg = shellWord(ROOT_FILE);
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f ${rootArg} config --no-env-resolution --format json
  (create an empty file and pass its path as --env-file)`,
    );
    expect(text).not.toContain("gone by now");
  });

  /**
   * The path as the gate writes it in the command: bare when it holds only
   * `[\w./:-]`, else in single quotes (the rule of `shellArg`).
   */
  function shellWord(path: string): string {
    return /[^\w./:-]/.test(path) ? `'${path}'` : path;
  }

  /** The text of a run whose root file is at `spelled` and fails. */
  function failedAt(spelled: string): { file: string; text: string } {
    const file = join(spelled, "compose.yaml");
    const docker = compose(PROBE_KEPT, exited("broken"));
    const realpath = (path: string): string => {
      if (path === file) return file;
      if (path === repoRoot) return spelled;
      throw new Error(`unexpected realpath ${path}`);
    };
    return { file, text: run(docker, cleanRead, [file], realpath).text };
  }

  it("quotes an argument of the command with a space, a dollar or a backquote in it, so no shell expands them", () => {
    const { file, text } = failedAt(resolve('/Odd "checkout" $HOME `x` root'));

    // In single quotes neither a POSIX shell nor PowerShell expands anything.
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f '${file}' config --no-env-resolution --format json\n`,
    );
  });

  it("quotes a bare path with backslashes in it, so a POSIX shell keeps them", () => {
    // No space, no dollar: only the backslashes of a Windows path.
    const spelled = process.platform === "win32" ? "D:\\x" : "/D:\\x";
    const { file, text } = failedAt(spelled);

    expect(file).toContain("\\");
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f '${file}' config --no-env-resolution --format json\n`,
    );
  });

  it("quotes a bare path with a plus in it, which a path of the pipeline may carry", () => {
    const { file, text } = failedAt(resolve("/a+b"));

    expect(file).toContain("+");
    expect(text).toContain(
      `  to read it, run: docker compose --env-file '<empty env file>' -f ${shellWord(file)} config --no-env-resolution --format json\n`,
    );
    expect(shellWord(file)).toBe(`'${file}'`);
  });

  it("writes a single quote of an argument the POSIX way and says so on a line of its own", () => {
    const { file, text } = failedAt(resolve("/O'Brien checkout"));

    expect(text).toContain(
      `-f '${file.replaceAll("'", "'\\''")}' config --no-env-resolution --format json\n  (POSIX sh quoting)\n`,
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

  it.each([
    ["ENOBUFS", "printed more than the gate reads (ENOBUFS)"],
    ["ETIMEDOUT", "ran past the time limit of the gate (ETIMEDOUT)"],
  ])(
    "tells a call the gate itself ended on %s from a signal, with no command to repeat",
    (code, ending) => {
      // How `execFileSync` throws it: Node ends the call with SIGTERM.
      const limited = Object.assign(
        new Error(`spawnSync docker ${code}\nKEY=${ENV_VALUE}`),
        { code, status: null, signal: "SIGTERM", stdout: "", stderr: "" },
      );

      const { code: exit, text } = run(compose(PROBE_KEPT, limited), cleanRead);

      expect(exit).toBe(1);
      expect(text).toContain(
        `  docker compose ${ending} - a limit of this gate, not a fault of the Compose files; what it printed is not repeated here`,
      );
      expect(text).not.toContain("SIGTERM");
      expect(text).not.toContain("to read it, run:");
      expect(text).not.toContain(ENV_VALUE);
    },
  );

  it("names the signal that ended docker", () => {
    const ended = Object.assign(
      new Error(`Command failed: docker compose config
KEY=${ENV_VALUE}`),
      { status: null, signal: "SIGTERM", stdout: "", stderr: ENV_VALUE },
    );

    const { code, text } = run(compose(PROBE_KEPT, ended), cleanRead);

    expect(code).toBe(1);
    expect(text).toContain("docker compose was ended by SIGTERM");
    expect(text).not.toContain(ENV_VALUE);
  });

  it.each([
    ["the rendering probe", (stdout: string) => compose(stdout)],
    ["the root file", (stdout: string) => compose(PROBE_KEPT, stdout)],
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
    const file = run(compose(PROBE_KEPT, new Error("stack: injected")));

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
      "  this docker compose prints the probe's create_host_path: false as {}",
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
