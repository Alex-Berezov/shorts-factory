import { existsSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ENV_TARGET,
  checkCompose,
  checkDockerignore,
} from "../scripts/compose-rules.mjs";
import { readIfFile } from "../scripts/lib/files.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  ROOT_OF,
  TEST_NAMES,
  WEB_SERVER,
  WORKSPACE_OF,
} from "../scripts/probe-image.mjs";
import {
  APP_DOCKERFILE,
  imagesOf,
  parseDockerfile,
  stagesOfImage,
  targetsOf,
} from "./dockerfile.js";
import { readManifest, readRepoFile } from "./repo-files.js";

/**
 * How the images of the application are built and start their service, a
 * test of the root project. Every image is a target of
 * `infra/docker/app.Dockerfile`, and Compose builds exactly those targets.
 * The container starts the worker exactly the way `pnpm dev` does
 * (`scripts.dev` of `apps/worker/package.json`), and that script is held to
 * the command the signal test (`apps/worker/test/entry-point.int.test.ts`)
 * proves the drain for by `apps/worker/test/dev-command.test.ts` - the chain
 * image = dev = signal test in two links. Anything in front of node - a
 * package manager, the `tsx` CLI, a shell from the shell form of `CMD` -
 * receives `docker stop`'s SIGTERM itself, and the service is killed after
 * the grace period.
 */
const ExecFormSchema = z.array(z.string()).min(1);
const IMAGES = imagesOf();

/** The Compose files of the full stack (the root compose.yaml includes both). */
const COMPOSE_FILES = [
  "infra/docker-compose.yml",
  "infra/docker-compose.app.yml",
];

/**
 * The package each tsx image runs, stated here and not taken from
 * `WORKSPACE_OF`: renaming a package in its manifest and in the table of the
 * probe together still turns this red.
 */
const PACKAGE_OF: Record<string, string> = {
  api: "@sf/api",
  worker: "@sf/worker",
  migrate: "@sf/db",
};

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

/** Instructions of every stage `image` is built from, by stage name. */
function stagesOf(image: string): Map<string, string[]> {
  return new Map(
    stagesOfImage(image).map((stage) => [stage.name, stage.instructions]),
  );
}

/** Instructions of one stage of `image`; throws when it has no such stage. */
function stageInstructions(image: string, stage: string): string[] {
  const found = stagesOf(image).get(stage);
  if (found === undefined) {
    throw new Error(`no stage "${stage}" in the stages of target ${image}`);
  }
  return found;
}

/** The runtime of an image is the target itself. */
const runtimeOf = (image: string): string[] => stageInstructions(image, image);

/** The stage that installs the packages of an image. */
const installStageOf = (image: string): string =>
  image === "web" ? "web-build" : `${image}-deps`;

/** The `CMD` the stage ends up with, as an argv; null for the shell form. */
function finalCommand(instructions: string[]): string[] | null {
  const commands = instructions.filter((line) => /^CMD\s/i.test(line));
  const last = commands.at(-1);
  if (last === undefined) {
    throw new Error("the stage has no CMD");
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

/** One service of a Compose file: its `build`, when it has one, or its image. */
interface ComposeService {
  file: string;
  name: string;
  image?: string;
  build?: {
    context: string;
    dockerfile: string;
    target: string;
    /** Names of `build.args`, in the map or the list form. */
    args: string[];
  };
}

/** Keys of a `build:` block the stack uses; any other is refused. */
const BUILD_KEYS = new Set(["context", "dockerfile", "target", "args"]);

/**
 * The services of the text of a Compose file, read by lines (`yaml` is not a
 * dependency, Р4 E0-12A): two-space service headers under the top-level
 * `services:`, with `image:` and the `build:` block of each, and the names
 * of its `args` (`NAME: value` or `- NAME=value` lines). A `build:` of any
 * other shape - the short form, a key the stack does not use, a missing
 * `context`, `dockerfile` or `target`, `args` not a block, a nested line
 * outside `args` - throws instead of being skipped.
 */
function composeServices(text: string, file: string): ComposeService[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf("services:");
  if (start === -1) throw new Error(`${file}: no top-level services:`);
  const services: ComposeService[] = [];
  let service: ComposeService | undefined;
  let build: Record<string, string> | undefined;
  let args: string[] = [];
  let inArgs = false;
  const close = () => {
    if (service === undefined || build === undefined) return;
    const { context, dockerfile, target } = build;
    if (
      context === undefined ||
      dockerfile === undefined ||
      target === undefined
    ) {
      throw new Error(
        `${file}: build of ${service.name} lacks context, dockerfile or target`,
      );
    }
    service.build = { context, dockerfile, target, args };
    build = undefined;
    args = [];
    inArgs = false;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    const header = /^ {2}([\w-]+):$/.exec(line);
    if (header?.[1] !== undefined) {
      close();
      service = { file, name: header[1] };
      services.push(service);
      continue;
    }
    if (service === undefined) {
      throw new Error(`${file}: line outside a service: ${line}`);
    }
    const field = /^ {4}([\w-]+):(.*)$/.exec(line);
    if (field?.[1] !== undefined) {
      close();
      const value = (field[2] ?? "").trim();
      if (field[1] === "build") {
        if (value !== "") {
          throw new Error(`${file}: build of ${service.name} is not a block`);
        }
        build = {};
      } else if (field[1] === "image") {
        service.image = value;
      }
      continue;
    }
    if (build === undefined) continue;
    const key = /^ {6}([\w-]+):(.*)$/.exec(line);
    if (key?.[1] !== undefined) {
      if (!BUILD_KEYS.has(key[1])) {
        throw new Error(`${file}: build.${key[1]} of ${service.name}`);
      }
      const value = (key[2] ?? "").trim();
      inArgs = key[1] === "args";
      if (inArgs && value !== "") {
        throw new Error(
          `${file}: build.args of ${service.name} is not a block`,
        );
      }
      build[key[1]] = value;
      continue;
    }
    const arg = /^ {8}(?:- )?([A-Za-z_]\w*)(?::|=|$)/.exec(line);
    if (!inArgs || arg?.[1] === undefined) {
      throw new Error(`${file}: unrecognised line in a build: ${line}`);
    }
    args.push(arg[1]);
  }
  close();
  return services;
}

/** Every service of the stack, from the files on disk. */
const SERVICES = COMPOSE_FILES.flatMap((file) =>
  composeServices(readRepoFile(file), file),
);

/**
 * How the builds of Compose disagree with the targets of the Dockerfile, one
 * line each; empty when they agree. Both ways: a target no service builds is
 * an image CI probes and nobody runs, a service building a target that is not
 * there - or from another Dockerfile - is an image no test reads.
 */
function buildMismatches(
  services: ComposeService[],
  targets: string[],
): string[] {
  const problems: string[] = [];
  const built = new Set<string>();
  for (const { file, name, build } of services) {
    if (build === undefined) continue;
    built.add(build.target);
    if (build.context !== "..") {
      problems.push(`${file}: ${name} builds from ${build.context}, not ..`);
    }
    if (build.dockerfile !== APP_DOCKERFILE) {
      problems.push(`${file}: ${name} builds ${build.dockerfile}`);
    }
    if (!targets.includes(build.target)) {
      problems.push(`${file}: ${name} builds target ${build.target}, no such`);
    }
  }
  for (const target of targets) {
    if (!built.has(target)) problems.push(`no service builds target ${target}`);
  }
  return problems;
}

/**
 * Build args a service may pass: the version stamp of api. Any other - in
 * particular `NODE_IMAGE` - would build an image on another node than the one
 * `app.Dockerfile` names.
 */
const BUILD_ARGS = new Set(["APP_VERSION", "GIT_COMMIT"]);

/** The build args of the services outside `BUILD_ARGS`, one line each. */
function foreignBuildArgs(services: ComposeService[]): string[] {
  return services.flatMap(({ file, name, build }) =>
    (build?.args ?? [])
      .filter((arg) => !BUILD_ARGS.has(arg))
      .map((arg) => `${file}: ${name} passes ${arg}`),
  );
}

describe("images and Compose", () => {
  const appText = readRepoFile("infra/docker-compose.app.yml");
  const dockerfile = readRepoFile(APP_DOCKERFILE);

  it("builds every target of app.Dockerfile, each by a service of its name, and nothing else", () => {
    expect(buildMismatches(SERVICES, IMAGES)).toEqual([]);
    expect(IMAGES).toEqual(["api", "migrate", "web", "worker"]);
    for (const { name, build } of SERVICES) {
      if (build !== undefined) expect(build.target).toBe(name);
    }
  });

  it("is red on a target no service builds", () => {
    const extra = `${dockerfile}\nFROM node:22-alpine AS debug\n`;

    expect(
      buildMismatches(SERVICES, targetsOf(parseDockerfile(extra))),
    ).toEqual(["no service builds target debug"]);
  });

  it("is red on a service that builds a target that is not there, or another Dockerfile", () => {
    const service = [
      "  extra:",
      "    build:",
      "      context: ..",
      "      dockerfile: infra/docker/extra.Dockerfile",
      "      target: extra",
    ].join("\n");
    const text = appText.replace("\nvolumes:", `\n${service}\n\nvolumes:`);
    const services = composeServices(text, "app.yml");

    expect(buildMismatches(services, IMAGES)).toEqual([
      "app.yml: extra builds infra/docker/extra.Dockerfile",
      "app.yml: extra builds target extra, no such",
    ]);
    const foreign = appText.replace("target: worker", "target: api");
    expect(
      buildMismatches(composeServices(foreign, "app.yml"), IMAGES),
    ).toEqual(["no service builds target worker"]);
  });

  it("passes no build arg but APP_VERSION and GIT_COMMIT", () => {
    expect(SERVICES.flatMap(({ build }) => build?.args ?? [])).toEqual([
      "APP_VERSION",
      "GIT_COMMIT",
    ]);
    expect(foreignBuildArgs(SERVICES)).toEqual([]);
  });

  it.each([
    [
      "the map form",
      "        GIT_COMMIT: ${GIT_COMMIT:-}\n",
      "        GIT_COMMIT: ${GIT_COMMIT:-}\n        NODE_IMAGE: node:20-alpine\n",
    ],
    [
      "the list form",
      "        APP_VERSION: ${APP_VERSION:-}\n        GIT_COMMIT: ${GIT_COMMIT:-}\n",
      "        - APP_VERSION\n        - NODE_IMAGE=node:20-alpine\n",
    ],
  ])("is red on a NODE_IMAGE build arg in %s", (_, from, to) => {
    expect(appText).toContain(from);
    const services = composeServices(appText.replace(from, to), "app.yml");

    expect(foreignBuildArgs(services)).toEqual([
      "app.yml: api passes NODE_IMAGE",
    ]);
  });

  it.each([
    ["the short form", "    build:\n      context: ..", "    build: .."],
    ["an unknown key", "      target: migrate", "      network: host"],
    ["a missing target", "      target: migrate\n", ""],
    [
      "args not a block",
      "      args:\n        APP_VERSION: ${APP_VERSION:-}\n        GIT_COMMIT: ${GIT_COMMIT:-}",
      "      args: { NODE_IMAGE: node:20-alpine }",
    ],
    [
      "a nested line outside args",
      "      target: migrate\n",
      "      target: migrate\n        extra: x\n",
    ],
  ])("refuses a build of %s instead of skipping it", (_, from, to) => {
    expect(appText).toContain(from);
    const broken = appText.replace(from, to);

    expect(() => composeServices(broken, "app.yml")).toThrow(/app\.yml: /);
  });
});

/**
 * Every image runs the same node: the image is named once, by `NODE_IMAGE`
 * before the first stage, and every stage that does not start from another
 * stage starts from it - `base`, which the installs build on, and the four
 * targets, which run what was installed.
 */
describe("node image", () => {
  const text = readRepoFile(APP_DOCKERFILE);

  /** The stages that start from an image, not from a stage, with that image. */
  function fromImages(dockerfile: string): [string, string][] {
    const stages = parseDockerfile(dockerfile);
    const names = new Set(stages.map(({ name }) => name));
    return stages
      .filter(({ from }) => !names.has(from))
      .map(({ name, from }) => [name, from]);
  }

  /**
   * How a Dockerfile breaks the one node image, one line each; empty when it
   * holds: `ARG NODE_IMAGE` stated exactly once, and every stage that starts
   * from an image starts from it.
   */
  function nodeImageViolations(dockerfile: string): string[] {
    const problems: string[] = [];
    const stated = dockerfile.match(/^ARG\s+NODE_IMAGE\b/gim) ?? [];
    if (stated.length !== 1) {
      problems.push(`ARG NODE_IMAGE is stated ${stated.length} times`);
    }
    for (const [name, from] of fromImages(dockerfile)) {
      if (from !== "${node_image}") {
        problems.push(`${name} starts from ${from}`);
      }
    }
    return problems;
  }

  it("is named once, before the first stage", () => {
    const preamble = text.slice(0, text.search(/^FROM\s/m));

    expect(preamble).toMatch(/^ARG NODE_IMAGE=node:22-alpine\r?$/m);
    expect(nodeImageViolations(text)).toEqual([]);
  });

  it("is the image of every stage that starts from an image", () => {
    expect(fromImages(text)).toEqual(
      ["base", ...["api", "worker", "migrate", "web"]].map((name) => [
        name,
        "${node_image}",
      ]),
    );
  });

  it.each([
    [
      "a target that names its node image itself",
      "FROM ${NODE_IMAGE} AS web",
      "FROM node:22-alpine AS web",
      "web starts from node:22-alpine",
    ],
    [
      "a second ARG NODE_IMAGE",
      "ARG NODE_IMAGE=node:22-alpine",
      "ARG NODE_IMAGE=node:22-alpine\nARG NODE_IMAGE=node:20-alpine",
      "ARG NODE_IMAGE is stated 2 times",
    ],
  ])("is red on %s", (_, from, to, problem) => {
    expect(text).toContain(from);

    expect(nodeImageViolations(text.replace(from, to))).toEqual([problem]);
  });
});

describe("worker image", () => {
  const instructions = runtimeOf("worker");

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
 * `scripts.dev`, so a change to either side alone is red here. web runs the
 * server of the standalone build the probe checks (`WEB_SERVER`).
 */
describe.each([
  ["api", apiDevCommand()],
  ["web", ["node", WEB_SERVER]],
])("%s image", (image, expected) => {
  const instructions = runtimeOf(image);

  it("starts node itself, in the exec form", () => {
    expect(finalCommand(instructions)).toEqual(expected);
  });

  it("puts no entry point in front of the command", () => {
    expect(entryPoints(instructions)).toEqual([]);
  });
});

/**
 * The Compose `migrate` service runs the migrations, then the seed, in one
 * node process (`src/cli/migrate-and-seed.ts` of `@sf/db`): the seed does not
 * run after a failed migration. The exec form puts no shell between the
 * engine and node: the shell of the shell form would take the signal. The
 * exec form alone does not stop node on SIGTERM - as PID 1 it ignores the
 * signal (no handler, no default action for PID 1) - so the Compose service
 * runs it under Docker's init (`init: true`, rule 13 of
 * scripts/compose-rules.mjs), and `docker compose stop migrate` ends it with
 * 143, not with a SIGKILL after the grace period.
 */
describe("migrate image", () => {
  const MIGRATE_AND_SEED = "src/cli/migrate-and-seed.ts";

  it("runs the migrations and the seed in one node process, in the exec form", () => {
    const commands = [...stagesOf("migrate").values()]
      .flat()
      .filter((line) => /^CMD\s/i.test(line));

    expect(commands).toHaveLength(1);
    expect(finalCommand(runtimeOf("migrate"))).toEqual([
      "node",
      "--import",
      "tsx",
      MIGRATE_AND_SEED,
    ]);
  });

  it("runs from the package whose entry point that is", () => {
    const dir = WORKSPACE_OF.migrate;
    expect(dir).toBe("packages/db");
    if (dir === undefined) throw new Error("migrate runs from no package");
    expect(existsSync(join(repoRoot, dir, MIGRATE_AND_SEED))).toBe(true);
  });
});

/**
 * Every image, web included, takes its packages from the lockfile only: each
 * `pnpm fetch` and `pnpm install` of the stages it is built from is
 * `--frozen-lockfile`, and each install is `--offline` - it gets nothing
 * `pnpm fetch` did not put in the store by the lockfile (docs/DECISIONS.md,
 * 10.10.2026: at no stage).
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
    expect(installs).toHaveLength(1);
    for (const install of installs) {
      expect(install).toMatch(/\s--offline(?:\s|$)/);
    }
  });
});

/** The flags of a `pnpm install` instruction. */
const flagsOf = (install: string): string[] =>
  install.replace(/^.*\bpnpm\s+install\s+/, "").split(/\s+/);

describe("web image install", () => {
  it("installs web and the packages it builds from, and nothing else", () => {
    const installs = [...stagesOf("web").values()]
      .flat()
      .filter((line) => /\bpnpm\s+install\b/.test(line));

    expect(installs).toHaveLength(1);
    expect(stageInstructions("web", installStageOf("web"))).toContain(
      installs[0],
    );
    const flags = flagsOf(installs[0] ?? "");
    expect(flags[flags.indexOf("--filter") + 1]).toBe("@sf/web...");
  });

  it("runs from the root of the standalone tree the probe checks", () => {
    const workdirs = runtimeOf("web").filter((line) =>
      /^WORKDIR\s/i.test(line),
    );

    expect(workdirs.at(-1)).toBe(`WORKDIR ${ROOT_OF.web}`);
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
    const deps = installStageOf(image);

    it("runs the package its name says", () => {
      expect(Object.keys(WORKSPACE_OF).sort()).toEqual(
        Object.keys(PACKAGE_OF).sort(),
      );
      expect(readManifest(dir).name).toBe(PACKAGE_OF[image]);
    });

    it("never uses pnpm deploy", () => {
      expect(
        everything.filter((line) => /\bpnpm\s+deploy\b/.test(line)),
      ).toEqual([]);
    });

    it("installs the package's production dependencies offline into a fresh node_modules", () => {
      const installs = stageInstructions(image, deps).filter((line) =>
        /\bpnpm\s+install\b/.test(line),
      );

      expect(installs).toHaveLength(1);
      const install = installs[0] ?? "";
      // The node_modules `pnpm fetch` left holds the whole workspace, dev tools
      // included, and reusing it stops pnpm at a purge prompt.
      expect(install).toMatch(/^RUN rm -rf node_modules && pnpm install\s/);
      expect(flagsOf(install)).toEqual(
        expect.arrayContaining([
          "--offline",
          "--frozen-lockfile",
          "--prod",
          "--filter",
          `${PACKAGE_OF[image]}...`,
        ]),
      );
    });

    it("runs from the package's directory of that install", () => {
      const runtime = runtimeOf(image);
      const copies = runtime.filter((line) => /^COPY\s/i.test(line));
      const workdirs = runtime.filter((line) => /^WORKDIR\s/i.test(line));

      expect(copies).toContain(
        `COPY --from=${deps} /repo/node_modules /repo/node_modules`,
      );
      for (const copy of copies) {
        expect(copy).toMatch(new RegExp(`^COPY --from=${deps} /repo/`));
      }
      expect(workdirs.at(-1)).toBe(
        `WORKDIR ${posix.join(ROOT_OF[image] ?? "", dir)}`,
      );
    });

    it("carries the tsconfig.base.json the package's tsconfig.json extends", () => {
      const copies = runtimeOf(image).filter((line) => /^COPY\s/i.test(line));
      const tsconfig = readRepoFile(`${dir}/tsconfig.json`);
      const extended = /"extends":\s*"([^"]+)"/.exec(tsconfig)?.[1];

      expect(copies).toContain(
        `COPY --from=${deps} /repo/tsconfig.base.json /repo/`,
      );
      expect(extended).toBeDefined();
      expect(posix.join(dir, extended ?? "")).toBe("tsconfig.base.json");
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

  /**
   * The tests of the packages never reach an image (decision Р1 of the
   * techlead, E0-12J): no runtime imports them, and a change to a test does
   * not invalidate the `COPY . .` layer of every target.
   */
  it.each([
    "**/test",
    "**/test-support",
    "**/*.test.ts",
    "**/vitest*.config.*",
  ])("keeps %s out of every image", (mask) => {
    const lines = readRepoFile(".dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim());

    expect(lines).toContain(mask);
  });

  /**
   * The probe looks in an image for the same tests these masks keep out:
   * `TEST_NAMES` of `scripts/probe-image.mjs` turned into masks is the block
   * of the masks in `.dockerignore`, line for line.
   */
  function testMasks(names: typeof TEST_NAMES): string[] {
    return [
      ...names.dirs.map((dir) => `**/${dir}`),
      `**/*${names.suffix}`,
      `**/${names.configPrefix}*${names.configPart}*`,
    ];
  }

  /** The block of `.dockerignore` from `**\/test` to the next blank line. */
  function testMaskBlock(): string[] {
    const lines = readRepoFile(".dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim());
    const first = lines.indexOf("**/test");
    expect(first).toBeGreaterThan(-1);
    return lines.slice(first, lines.indexOf("", first));
  }

  it("masks exactly the tests the image probe looks for (TEST_NAMES)", () => {
    expect(testMaskBlock()).toEqual(testMasks(TEST_NAMES));
  });

  it("is red when TEST_NAMES looks for a test the masks let in", () => {
    expect(testMaskBlock()).not.toEqual(
      testMasks({ ...TEST_NAMES, suffix: ".spec.ts" }),
    );
    expect(testMaskBlock()).not.toEqual(
      testMasks({ ...TEST_NAMES, dirs: [...TEST_NAMES.dirs, "__tests__"] }),
    );
  });

  it("is not replaced by a .dockerignore of a Dockerfile", () => {
    // The services of the Compose files as read above, with their context
    // made absolute: rule 0 wants every service of the stack, rule 11 reads
    // the .dockerignore of each build.
    const services = Object.fromEntries(
      SERVICES.map(({ name, image, build }) => [
        name,
        build === undefined
          ? { image }
          : {
              build: {
                context: join(repoRoot, "infra", build.context),
                dockerfile: build.dockerfile,
              },
            },
      ]),
    );
    const project = {
      composeFile: join(repoRoot, "compose.yaml"),
      envFile: join(repoRoot, ".env"),
      testEnvFile: join(repoRoot, ".env.test"),
      read: readIfFile,
      realpath: realpathSync.native,
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
      const workdirs = runtimeOf(image).filter((line) =>
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
