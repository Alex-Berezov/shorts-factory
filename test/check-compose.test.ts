import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";

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
afterAll(() => {
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
