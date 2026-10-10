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
 * (rule 11) - files, not secrets.
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
 * Usage: `node scripts/check-compose.mjs [compose file]`.
 * Exit 1 with every violation listed; exit 0 when clean.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  RENDERING_PROBE,
  RENDERING_PROBE_SOURCE,
  checkBuildIgnores,
  checkCompose,
  checkRendering,
  defaultComposeFile,
} from "./compose-rules.mjs";

const file = resolve(process.argv[2] ?? defaultComposeFile(import.meta.url));
// Compose resolves a bind source against the project directory - the
// directory of the first compose file - and prints it absolute.
const envFile = join(dirname(file), ".env");

const scratch = mkdtempSync(join(tmpdir(), "sf-check-compose-"));
const emptyEnvFile = join(scratch, "empty.env");
writeFileSync(emptyEnvFile, "");

const probeFile = join(scratch, "probe.yaml");
writeFileSync(probeFile, RENDERING_PROBE);
writeFileSync(join(scratch, RENDERING_PROBE_SOURCE), "");

/** `docker compose` with `args`, its standard output. */
function compose(args) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The resolved configuration of `composeFile`, as JSON. */
function render(composeFile) {
  return JSON.parse(
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
}

let config;
let rendering;
try {
  rendering = checkRendering(render(probeFile));
  if (rendering.length > 0) {
    rendering.push(
      `docker compose version: ${compose(["version", "--short"]).trim()}`,
    );
  } else {
    config = render(file);
  }
} catch (error) {
  if (error.code === "ENOENT") {
    // No Docker CLI is a missing prerequisite, not a broken Compose file.
    console.error(
      "check-compose: the docker CLI is not on PATH - install Docker (the daemon is not needed); the Compose files were not checked",
    );
    process.exit(1);
  }
  console.error(`check-compose: docker compose config failed for ${file}`);
  console.error(String(error.stderr ?? error.message ?? error));
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (rendering.length > 0) {
  console.error("check-compose: the rendering probe failed");
  for (const problem of rendering) console.error(`  ${problem}`);
  process.exit(1);
}

/** Contents of a file, null if there is no file at `path`. */
function readIfFile(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const problems = [
  ...checkCompose(config, { envFile }),
  ...checkBuildIgnores(config, readIfFile),
];
if (problems.length > 0) {
  console.error(`check-compose: ${file}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("check-compose: clean");
