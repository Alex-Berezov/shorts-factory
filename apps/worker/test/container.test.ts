import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkBuildIgnores,
  checkDockerignore,
} from "../../../scripts/compose-rules.mjs";
import { DEV_COMMAND } from "./dev-command.js";

/**
 * The container starts the worker exactly the way `pnpm dev` does, and the
 * signal test (`entry-point.int.test.ts`) proves the drain for that command.
 * Anything in front of node - a package manager, the `tsx` CLI, a shell from
 * the shell form of `CMD` - receives `docker stop`'s SIGTERM itself, and the
 * worker is killed after the grace period with its jobs in flight.
 */
function dockerfilePath(image: string): string {
  return fileURLToPath(
    new URL(`../../../infra/docker/${image}.Dockerfile`, import.meta.url),
  );
}
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const ManifestSchema = z.object({ scripts: z.object({ dev: z.string() }) });
const ExecFormSchema = z.array(z.string()).min(1);
const IMAGES = ["api", "worker", "migrate", "web"];
const PackageNameSchema = z.object({ name: z.string() });

/** Contents of a file, null if there is no file at `path`. */
function readIfFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The stage every service is built from (`target:` in Compose). */
const RUNTIME_STAGE = "runtime";

/**
 * Instructions of every stage by its name, continuation lines joined. Enough
 * of the Dockerfile grammar for the images of this repository; comments are
 * dropped.
 */
function stagesOf(image: string): Map<string, string[]> {
  const dockerfile = readFileSync(dockerfilePath(image), "utf8");
  const lines = dockerfile
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const stages = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from !== null) {
      current = [];
      stages.set((from[1] ?? "").toLowerCase(), current);
      continue;
    }
    current?.push(line);
  }
  return stages;
}

/** Instructions of one stage; throws when the image has no such stage. */
function stageInstructions(image: string, stage: string): string[] {
  const found = stagesOf(image).get(stage);
  if (found === undefined) {
    throw new Error(`no stage "${stage}" in ${image}.Dockerfile`);
  }
  return found;
}

/** The `CMD` the stage ends up with, as an argv; null for the shell form. */
function finalCommand(instructions: string[]): string[] | null {
  const commands = instructions.filter((line) => /^CMD\s/i.test(line));
  const last = commands.at(-1);
  if (last === undefined) {
    throw new Error(`stage "${RUNTIME_STAGE}" has no CMD`);
  }
  const argument = last.replace(/^CMD\s+/i, "");
  if (!argument.startsWith("[")) {
    return null;
  }
  return ExecFormSchema.parse(JSON.parse(argument));
}

/** `ENTRYPOINT` instructions of the stage, in either form. */
function entryPoints(instructions: string[]): string[] {
  return instructions.filter((line) => /^ENTRYPOINT\s/i.test(line));
}

describe("worker image", () => {
  const instructions = stageInstructions("worker", RUNTIME_STAGE);

  it("starts node itself, in the exec form", () => {
    const command = finalCommand(instructions);

    expect(command).not.toBeNull();
    expect(command?.[0]).toBe("node");
  });

  it("runs the command `pnpm dev` runs", () => {
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(MANIFEST, "utf8")),
    );

    expect(finalCommand(instructions)?.join(" ")).toBe(DEV_COMMAND);
    expect(manifest.scripts.dev).toBe(DEV_COMMAND);
  });

  it("puts no entry point in front of the command", () => {
    expect(entryPoints(instructions)).toEqual([]);
  });
});

/**
 * api and web stop the same way: `docker stop` sends SIGTERM to PID 1, and
 * only node itself in that place closes the server and its connections
 * before the grace period ends in SIGKILL.
 */
describe.each([
  ["api", ["node", "--import", "tsx", "src/server.ts"]],
  ["web", ["node", "apps/web/server.js"]],
])("%s image", (image, expected) => {
  const instructions = stageInstructions(image, RUNTIME_STAGE);

  it("starts node itself, in the exec form", () => {
    expect(finalCommand(instructions)).toEqual(expected);
  });

  it("puts no entry point in front of the command", () => {
    expect(entryPoints(instructions)).toEqual([]);
  });
});

/**
 * Every image, web included, takes its packages from the lockfile only: each
 * `pnpm fetch` and `pnpm install` is `--frozen-lockfile`, and each install is
 * `--offline` - it gets nothing `pnpm fetch` did not put in the store by the
 * lockfile (docs/DECISIONS.md, 10.10.2026: at no stage).
 */
describe.each(IMAGES)("%s image package installs", (image) => {
  const everything = [...stagesOf(image).values()].flat();
  const pnpmSteps = everything.filter((line) =>
    /\bpnpm\s+(?:fetch|install)\b/.test(line),
  );
  const installs = everything.filter((line) => /\bpnpm\s+install\b/.test(line));

  it("fetches and installs by the lockfile only, at every stage", () => {
    expect(pnpmSteps.length).toBeGreaterThan(0);
    for (const step of pnpmSteps) {
      expect(step).toMatch(/\s--frozen-lockfile(?:\s|$)/);
    }
  });

  it("installs offline, at every stage", () => {
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) {
      expect(install).toMatch(/\s--offline(?:\s|$)/);
    }
  });
});

/**
 * api, worker and migrate run their sources through `tsx` and need only the
 * production dependencies - exactly the versions of the lockfile, the ones CI
 * and `pnpm dev` run. `pnpm deploy` (pnpm 9) resolves its copy again from the
 * semver ranges, so it must not come back (docs/DECISIONS.md, 10.10.2026).
 */
describe.each([
  ["api", "@sf/api", "apps/api"],
  ["worker", "@sf/worker", "apps/worker"],
  ["migrate", "@sf/db", "packages/db"],
])("%s image dependencies", (image, pkg, dir) => {
  const everything = [...stagesOf(image).values()].flat();

  it("never uses pnpm deploy", () => {
    expect(everything.filter((line) => /\bpnpm\s+deploy\b/.test(line))).toEqual(
      [],
    );
  });

  it("installs the package's production dependencies offline into a fresh node_modules", () => {
    const installs = stageInstructions(image, "prod").filter((line) =>
      /\bpnpm\s+install\b/.test(line),
    );

    expect(installs).toHaveLength(1);
    const install = installs[0] ?? "";
    // The node_modules `pnpm fetch` left holds the whole workspace, dev tools
    // included, and reusing it stops pnpm at a purge prompt.
    expect(install).toMatch(/^RUN rm -rf node_modules && pnpm install\s/);
    const flags = install.replace(/^.*\bpnpm\s+install\s+/, "").split(/\s+/);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--offline",
        "--frozen-lockfile",
        "--prod",
        "--filter",
        `${pkg}...`,
      ]),
    );
  });

  it("runs from the package's directory of that install", () => {
    const runtime = stageInstructions(image, RUNTIME_STAGE);
    const copies = runtime.filter((line) => /^COPY\s/i.test(line));
    const workdirs = runtime.filter((line) => /^WORKDIR\s/i.test(line));
    const manifest = PackageNameSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(`../../../${dir}/package.json`, import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(copies).toContain(
      "COPY --from=prod /repo/node_modules /repo/node_modules",
    );
    for (const copy of copies) {
      expect(copy).toMatch(/^COPY --from=prod \/repo\//);
    }
    expect(workdirs.at(-1)).toBe(`WORKDIR /repo/${dir}`);
    expect(manifest.name).toBe(pkg);
  });
});

/**
 * Every image is built with the repository root as its context and `COPY . .`,
 * so `.dockerignore` is all that keeps the operator's `.env` - and any
 * `.env.local`, `.env.production` - out of the image layers. The rule (11 of
 * scripts/compose-rules.mjs, tested in compose-rules.test.ts) applied to the
 * files of this repository, so `pnpm test` sees a broken one too, not only the
 * compose gate.
 */
describe(".dockerignore", () => {
  it("masks every .env and lets none back in", () => {
    const file = fileURLToPath(
      new URL("../../../.dockerignore", import.meta.url),
    );

    expect(checkDockerignore(readFileSync(file, "utf8"), file)).toEqual([]);
  });

  it("is not replaced by a .dockerignore of a Dockerfile", () => {
    // The images of this file, not the parsed Compose: the compose gate
    // (scripts/check-compose.mjs) takes them from `docker compose config`.
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const services = Object.fromEntries(
      IMAGES.map((image) => [
        image,
        {
          build: {
            context: root,
            dockerfile: relative(root, dockerfilePath(image)),
          },
        },
      ]),
    );

    expect(checkBuildIgnores({ services }, readIfFile)).toEqual([]);
  });
});
