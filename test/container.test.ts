import { existsSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ENV_TARGET,
  checkCompose,
  checkDockerignore,
} from "../scripts/compose-rules.mjs";
import { readIfFile } from "../scripts/lib/files.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { WORKSPACE_OF } from "../scripts/probe-image.mjs";
import { dockerfilePath, imagesOf, stagesOfImage } from "./dockerfile.js";
import { readManifest, readRepoFile } from "./repo-files.js";

/**
 * How the images of `infra/docker` start their service, a test of the root
 * project. The container starts the worker exactly the way `pnpm dev` does
 * (`scripts.dev` of `apps/worker/package.json`), and that script is held to
 * the command the signal test (`apps/worker/test/entry-point.int.test.ts`)
 * proves the drain for by `apps/worker/test/dev-command.test.ts` - the chain
 * image = dev = signal test in two links. Anything in front of node - a
 * package manager, the `tsx` CLI, a shell from the shell form of `CMD` -
 * receives `docker stop`'s SIGTERM itself, and the worker is killed after the
 * grace period with its jobs in flight.
 */
const ExecFormSchema = z.array(z.string()).min(1);
const IMAGES = imagesOf();

/**
 * The command `pnpm dev` runs in a package directory, from its manifest. Read
 * as a file, not imported: the root project imports no package.
 */
function devScriptOf(dir: string): string {
  const dev = readManifest(dir).scripts?.dev;
  if (dev === undefined)
    throw new Error(`${dir}/package.json has no dev script`);
  return dev;
}

/** The stage every service is built from (`target:` in Compose). */
const RUNTIME_STAGE = "runtime";

/** Instructions of every stage by its name; see `dockerfile.ts` for the grammar. */
function stagesOf(image: string): Map<string, string[]> {
  return new Map(
    stagesOfImage(image).map((stage) => [stage.name, stage.instructions]),
  );
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
    expect(finalCommand(instructions)?.join(" ")).toBe(
      devScriptOf("apps/worker"),
    );
  });

  it("puts no entry point in front of the command", () => {
    expect(entryPoints(instructions)).toEqual([]);
  });
});

/** The command `pnpm dev` runs the api with, as an argv. */
function apiDevCommand(): string[] {
  return devScriptOf("apps/api").split(/\s+/);
}

/**
 * api and web stop the same way: `docker stop` sends SIGTERM to PID 1, and
 * only node itself in that place closes the server and its connections
 * before the grace period ends in SIGKILL. The api image runs the very
 * command `pnpm dev` runs (Р8 E0-11A): the expected argv is the api's own
 * `scripts.dev`, so a change to either side alone is red here. web has no
 * dev command of that shape, and its argv is stated as it is.
 */
describe.each([
  ["api", apiDevCommand()],
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
 * The Compose `migrate` service runs the image's command: both entry points
 * of `@sf/db`, the seed only after the migrations succeeded - the worker
 * refuses to start without the queue switches the seed writes. A one-shot
 * process, so the shell form of its `CMD` is read as it is: the steps between
 * `&&`, in order.
 */
describe("migrate image", () => {
  const instructions = stageInstructions("migrate", RUNTIME_STAGE);
  const commands = [...stagesOf("migrate").values()]
    .flat()
    .filter((line) => /^CMD\s/i.test(line));

  it("runs the migrations, then the seed", () => {
    expect(commands).toHaveLength(1);
    const command = instructions.filter((line) => /^CMD\s/i.test(line));
    expect(command).toEqual(commands);
    const steps = (command[0] ?? "")
      .replace(/^CMD\s+/i, "")
      .split("&&")
      .map((step) => step.trim());

    expect(steps).toEqual([
      "node --import tsx src/cli/migrate.ts",
      "node --import tsx src/cli/seed.ts",
    ]);
  });

  it("runs from the package whose entry points those are", () => {
    // The image's working directory is the package (`WORKSPACE_OF`), and the
    // steps name its scripts relative to it.
    const dir = WORKSPACE_OF.migrate;
    expect(dir).toBe("packages/db");
    if (dir === undefined) throw new Error("migrate runs from no package");
    expect(readManifest(dir).name).toBe("@sf/db");
    for (const script of ["src/cli/migrate.ts", "src/cli/seed.ts"]) {
      expect(existsSync(join(repoRoot, dir, script)), script).toBe(true);
    }
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
describe.each(Object.entries(WORKSPACE_OF))(
  "%s image dependencies",
  (image, dir) => {
    const everything = [...stagesOf(image).values()].flat();
    // The package the image runs, named by the manifest of its directory: the
    // map of scripts/probe-image.mjs is the one place that ties them.
    const pkg = readManifest(dir).name;

    it("never uses pnpm deploy", () => {
      expect(
        everything.filter((line) => /\bpnpm\s+deploy\b/.test(line)),
      ).toEqual([]);
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

      expect(copies).toContain(
        "COPY --from=prod /repo/node_modules /repo/node_modules",
      );
      for (const copy of copies) {
        expect(copy).toMatch(/^COPY --from=prod \/repo\//);
      }
      expect(workdirs.at(-1)).toBe(`WORKDIR /repo/${dir}`);
    });
  },
);

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
    const file = join(repoRoot, ".dockerignore");

    expect(checkDockerignore(readRepoFile(".dockerignore"), file)).toEqual([]);
  });

  it("is not replaced by a .dockerignore of a Dockerfile", () => {
    // The images of infra/docker, not the parsed Compose: the compose gate
    // (scripts/check-compose.mjs) takes them from `docker compose config`.
    // Postgres and Redis run from images; every other service of the stack
    // must have a Dockerfile here, or rule 0 reports it missing.
    const services = {
      postgres: { image: "postgres:16" },
      redis: { image: "redis:7" },
      ...Object.fromEntries(
        IMAGES.map((image) => [
          image,
          {
            build: {
              context: repoRoot,
              dockerfile: relative(repoRoot, dockerfilePath(image)),
            },
          },
        ]),
      ),
    };

    const project = {
      envFile: join(repoRoot, ".env"),
      testEnvFile: join(repoRoot, ".env.test"),
      read: readIfFile,
    };

    expect(checkCompose({ services }, project, ["build-ignores"])).toEqual([]);
  });
});

/**
 * Rule 10 of the compose gate holds every app service to a bind mount of the
 * project's `.env` at `ENV_TARGET`. The constant stays in the gate (a root
 * script imports no package), so this ties it to both ends it stands for:
 * the root of the layout the tsx images run in (`WORKDIR /repo/<package>`),
 * and the root `rootEnvFilePath` of @sf/config is built from. Moving either
 * without the gate turns these red, not only a container that no longer
 * sees its `.env`.
 */
describe("the .env the images read", () => {
  it("is mounted where the gate expects it", () => {
    expect(ENV_TARGET).toBe("/repo/.env");
  });

  it.each(Object.entries(WORKSPACE_OF))(
    "lies at the root of the %s image's layout",
    (image, dir) => {
      const workdirs = stageInstructions(image, RUNTIME_STAGE).filter((line) =>
        /^WORKDIR\s/i.test(line),
      );

      expect(workdirs.at(-1)).toBe(
        `WORKDIR ${posix.join(posix.dirname(ENV_TARGET), dir)}`,
      );
    },
  );

  it("is the file @sf/config reads at the root of the repository", () => {
    // Read as text, as the manifests above: the root project imports no
    // package. packages/config/src is three levels below the root.
    const paths = readRepoFile("packages/config/src/paths.ts");

    expect(paths).toMatch(
      /export const repoRoot = resolve\(\s*dirname\(fileURLToPath\(import\.meta\.url\)\),\s*"\.\.\/\.\.\/\.\.",?\s*\);/,
    );
    expect(paths).toContain(
      'export const rootEnvFilePath = join(repoRoot, ".env");',
    );
  });
});
