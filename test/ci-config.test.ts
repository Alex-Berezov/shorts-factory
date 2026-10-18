import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { imagesOf } from "./dockerfile.js";
import {
  type Manifest,
  type Turbo,
  readManifest,
  readRepoFile,
  readRepoJson,
  readTurbo,
} from "./repo-files.js";

/**
 * What the CI configuration must keep, without a run of Actions to find out:
 * the triggers and the concurrency rule, the services, the steps and their
 * order, the image matrix, and the one turbo cache of the workflow - the
 * local cache of job ci, one archive per ISO week, never a remote one. What
 * the turbo hash of a task covers is `turbo-inputs.test.ts`. A test of the
 * root project, next to the other tests of how the repository is built and
 * run (container.test.ts, compose-rules.test.ts); `//#test:repo` hashes every
 * tracked file of the repository, so each file read here is in its hash.
 */
const read = readRepoFile;
const workflow = read(".github/workflows/ci.yml").replace(/\r\n/g, "\n");

/** Lines of the block under `header` (a line ending in `:`), by indentation. */
function blockOf(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === header);
  if (start === -1) throw new Error(`no block "${header}"`);
  const indent = header.length - header.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const comment = line.trimStart().startsWith("#");
    if (
      line.trim() !== "" &&
      !comment &&
      line.length - line.trimStart().length <= indent
    ) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

interface Step {
  run: string | undefined;
  if: string | undefined;
  text: string;
}

/** The steps of a job of `text`, in order; comment lines are not part of a step. */
function stepsIn(text: string, job: string): Step[] {
  const steps = blockOf(blockOf(text, `  ${job}:`), "    steps:")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return steps
    .split(/\n(?= {6}- )/)
    .filter((text) => text.trim().startsWith("- "))
    .map((text) => {
      const field = (key: string) =>
        new RegExp(`^ {6}[- ] ${key}: (.*)$`, "m")
          .exec(text)?.[1]
          ?.replace(/^"(.*)"$/, "$1");
      return { run: field("run"), if: field("if"), text };
    });
}

/** The steps of a job of the workflow, in order. */
const stepsOf = (job: string): Step[] => stepsIn(workflow, job);

/** The step whose command runs the entry of `pnpm db:migrate`. */
const isMigrate = (step: Step) =>
  step.run?.includes("src/cli/migrate.ts") === true;

/**
 * The value that follows `key:` in the top-level `concurrency:` of the
 * workflow, `${{ }}` parts included.
 */
function workflowValue(key: string, text: string = workflow): string {
  const line = blockOf(text, "concurrency:")
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.startsWith(`${key}:`));
  if (line === undefined || !line.includes("${{")) {
    throw new Error(`no expression at "${key}"`);
  }
  return line.slice(key.length + 1).trim();
}

interface Event {
  name: "push" | "pull_request";
  number: number | null;
  sha: string;
}

/**
 * Evaluates an expression of the workflow for one event. The operators used
 * (`==`, `!=`, `&&`, `||`) mean the same in Actions and in JavaScript, and the
 * contexts are replaced by their values first; a context the event does not
 * have is null, as in Actions.
 */
function evaluateOne(expression: string, event: Event): string | boolean {
  const values: Record<string, string | number | null> = {
    "github.event_name": event.name,
    "github.event.pull_request.number": event.number,
    "github.sha": event.sha,
  };
  const source = expression.replace(/github(?:\.\w+)+/g, (name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`unknown context ${name}`);
    }
    return JSON.stringify(values[name]);
  });
  return new Function(`return (${source});`)() as string | boolean;
}

/**
 * A value of the workflow for one event: a lone `${{ }}` keeps the type of
 * its result, a string with several is formatted like Actions does.
 */
function evaluate(value: string, event: Event): string | boolean {
  const lone = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
  if (lone?.[1] !== undefined) return evaluateOne(lone[1], event);
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) =>
    String(evaluateOne(expression, event)),
  );
}

const push = (sha: string): Event => ({ name: "push", number: null, sha });
const pullRequest = (number: number, sha: string): Event => ({
  name: "pull_request",
  number,
  sha,
});

describe("blockOf", () => {
  it("does not end a block at a comment in column 0", () => {
    const text = [
      "jobs:",
      "  ci:",
      "    steps:",
      "      - run: a",
      "# note",
      "      - if: github.event_name == 'never'",
      "        run: b",
      "  next:",
      "    x: 1",
    ].join("\n");

    expect(blockOf(text, "    steps:")).toContain("run: b");
    expect(blockOf(text, "    steps:")).not.toContain("x: 1");
  });
});

describe("stepsIn", () => {
  it("leaves the comment lines out of the text of a step", () => {
    const text = [
      "jobs:",
      "  ci:",
      "    steps:",
      "      # uses: actions/setup-node@v4",
      "      - run: a",
      "      # if: github.event_name == 'never'",
      "      - run: b",
    ].join("\n");

    const steps = stepsIn(text, "ci");

    expect(steps.map((step) => step.run)).toEqual(["a", "b"]);
    expect(steps.map((step) => step.text).join("\n")).not.toContain("#");
  });
});

describe("workflowValue", () => {
  it("reads the top-level concurrency, not a group: or concurrency: of a job", () => {
    const text = [
      "jobs:",
      "  other:",
      "    concurrency:",
      "      group: job-${{ github.sha }}",
      "concurrency:",
      "  group: top-${{ github.sha }}",
    ].join("\n");

    expect(workflowValue("group", text)).toBe("top-${{ github.sha }}");
  });
});

describe("ci.yml triggers", () => {
  it("runs on pushes to main and on pull requests, and on nothing else", () => {
    expect(blockOf(workflow, "on:").trim().split("\n")).toEqual([
      "push:",
      "    branches: [main]",
      "  pull_request:",
    ]);
  });
});

describe("ci.yml permissions and time limits", () => {
  const lines = (block: string) =>
    block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  it("grants the token read access to the contents and nothing more", () => {
    expect(lines(blockOf(workflow, "permissions:"))).toEqual([
      "contents: read",
    ]);
    for (const job of ["ci", "docker-build"]) {
      expect(blockOf(workflow, `  ${job}:`)).not.toMatch(/^ {4}permissions:/m);
    }
  });

  it.each(["ci", "docker-build"])("bounds the run of job %s", (job) => {
    const limit = /^ {4}timeout-minutes: (\d+)$/m.exec(
      blockOf(workflow, `  ${job}:`),
    )?.[1];

    expect(Number(limit)).toBeGreaterThan(0);
    expect(Number(limit)).toBeLessThanOrEqual(60);
  });
});

describe("ci.yml concurrency", () => {
  const group = (event: Event) =>
    evaluate(workflowValue("group"), event) as string;
  const cancels = (event: Event) =>
    evaluate(workflowValue("cancel-in-progress"), event);

  it("keeps a pull request in one group, apart from any other pull request", () => {
    expect(group(pullRequest(7, "a1"))).toBe(group(pullRequest(7, "b2")));
    expect(group(pullRequest(7, "a1"))).not.toBe(group(pullRequest(8, "a1")));
    expect(workflowValue("group")).toContain(
      "github.event.pull_request.number",
    );
  });

  it("cancels the superseded run of a pull request", () => {
    expect(cancels(pullRequest(7, "a1"))).toBe(true);
  });

  it("gives every commit on main a group of its own and cancels none", () => {
    expect(group(push("a1"))).not.toBe(group(push("b2")));
    expect(group(push("a1"))).not.toBe(group(pullRequest(7, "a1")));
    expect(workflowValue("group")).toContain("github.sha");
    expect(cancels(push("a1"))).toBe(false);
  });
});

describe("ci.yml job ci", () => {
  const steps = stepsOf("ci");
  const runs = steps.map((step) => step.run);

  it("has Postgres and Redis on the ports and database of .env.test", () => {
    const env = parseEnv(read(".env.test"));
    const database = new URL(env.DATABASE_URL ?? "");
    const redis = new URL(env.REDIS_URL ?? "");
    const services = blockOf(blockOf(workflow, "  ci:"), "    services:");
    const postgres = blockOf(services, "      postgres:");

    expect(postgres).toContain(`- ${database.port}:5432`);
    expect(postgres).toContain(`POSTGRES_USER: ${database.username}`);
    expect(postgres).toContain(`POSTGRES_PASSWORD: ${database.password}`);
    expect(postgres).toContain(
      `POSTGRES_DB: ${database.pathname.replace(/^\//, "")}`,
    );
    expect(postgres).toContain("--health-cmd");
    const redisService = blockOf(services, "      redis:");
    expect(redisService).toContain(`- ${redis.port}:6379`);
    expect(redisService).toContain("--health-cmd");
  });

  it("installs, lints, typechecks, tests, migrates, runs the integration tests and builds, in that order", () => {
    const order: ((step: Step) => boolean)[] = [
      (step) => step.run === "pnpm install --frozen-lockfile",
      (step) => step.run === "pnpm lint",
      (step) => step.run === "pnpm typecheck",
      (step) => step.run === "pnpm test",
      isMigrate,
      (step) => step.run === "pnpm test:int",
      (step) => step.run === "pnpm build",
    ];
    const at = order.map((matches) => steps.findIndex(matches));

    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  // The gates that are not `pnpm` tasks (those have steps of their own, above).
  const GateSchema = z.object({ cmd: z.string() });
  const gates = z
    .object({ gates: z.array(GateSchema) })
    .parse(readRepoJson(".claude/hooks/rules.sf.json"))
    .gates.map((gate) => gate.cmd)
    .filter((cmd) => !cmd.startsWith("pnpm "));

  it("runs every gate of .claude/hooks/rules.sf.json that is not a pnpm task", () => {
    expect(gates.length).toBeGreaterThanOrEqual(4);
    for (const cmd of gates) expect(runs).toContain(cmd);
  });

  it("runs those gates after the tests and before the migration", () => {
    const test = runs.indexOf("pnpm test");
    const migrate = steps.findIndex(isMigrate);

    for (const cmd of gates) {
      const at = runs.indexOf(cmd);
      expect(at, cmd).toBeGreaterThan(test);
      expect(at, cmd).toBeLessThan(migrate);
    }
  });

  it("checks the Compose files with the pinned Compose, verified by its checksum", () => {
    const install = steps.findIndex((step) =>
      step.text.includes("docker-compose-linux-x86_64"),
    );
    const text = steps[install]?.text ?? "";
    const version = /\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(text)?.[1];

    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(
      runs.indexOf("node scripts/check-compose.mjs"),
    );
    expect(version).toBe("5.5.1");
    expect(text).toMatch(/\b[0-9a-f]{64} {2}\S+ \| sha256sum -c -/);
    expect(text).toContain(
      `test "$(docker compose version --short)" = "${version}"`,
    );
  });

  it("caches the pnpm store through setup-node", () => {
    const setup = steps.find((step) =>
      step.text.includes("actions/setup-node"),
    );

    expect(setup?.text).toMatch(/node-version: 22\b/);
    expect(setup?.text).toMatch(/cache: pnpm\b/);
  });

  it("migrates with the entry of `pnpm db:migrate` and .env.test as a dotenv file", () => {
    const step = steps.find(isMigrate);
    const script = readManifest("packages/db").scripts?.["db:migrate"];

    expect(step?.text).toContain("working-directory: packages/db");
    expect(script).toMatch(/^tsx \S+$/);
    expect(step?.run).toBe(
      `node --env-file=../../.env.test --import ${script}`,
    );
  });

  it("lets no step fail quietly", () => {
    expect(workflow).not.toMatch(/continue-on-error/);
    expect(workflow).not.toMatch(/\|\|\s*true/);
    expect(workflow).not.toMatch(/\|\|\s*exit\s+0/);
  });
});

/** Where turbo 2.10 keeps its local cache, from the root of the repository. */
const TURBO_CACHE_DIR = ".turbo/cache";
const WEEK = "${{ steps.week.outputs.week }}";
/**
 * Ways to reach a remote cache or to step around the local one: the flags
 * and the variables of turbo that set the same (`TURBO_CACHE` also stands
 * for `TURBO_CACHE_DIR`; `--no-cache`, the turbo 1 form of `--cache=`).
 */
const NO_REMOTE = [
  "TURBO_TOKEN",
  "TURBO_TEAM",
  "TURBO_API",
  "TURBO_REMOTE_",
  "TURBO_FORCE",
  "TURBO_CACHE",
  "--cache-dir",
  "--remote-only",
  "--force",
  "--no-cache",
];
/** Keys of turbo.json that move the local cache or add a remote one. */
const TURBO_CACHE_KEYS = ["remoteCache", "cacheDir"] as const;

/** The value of `key:` in the text of a step, unquoted. */
function stepField(text: string, key: string): string | undefined {
  return new RegExp(`^\\s+${key}: (.*)$`, "m")
    .exec(text)?.[1]
    ?.trim()
    .replace(/^"(.*)"$/, "$1");
}

/**
 * Every way the CI configuration could break the cache of turbo, one line
 * each; empty when clean. The archive of `.turbo/cache` is one per ISO week,
 * kept by the one job that runs the tasks: no commit in the key and no
 * restore keys, so a run never saves a grown copy of the archive it
 * restored. Nothing reaches a remote cache, and nothing makes a task skip
 * the cache it has. `workflow` is the text of ci.yml, `turbo` and `manifest`
 * the root turbo.json and package.json as parsed.
 */
function turboCacheViolations(
  workflow: string,
  turbo: Turbo,
  manifest: Manifest,
): string[] {
  const problems: string[] = [];
  // Every action of actions/cache counts, `cache/save` and `cache/restore`
  // too: a second step that saves would grow the archive again.
  const uses =
    workflow.match(/^\s*(?:- )?uses:\s*["']?actions\/cache(?:\/[\w-]+)?@/gim) ??
    [];
  if (uses.length !== 1) {
    problems.push(`ci.yml: ${uses.length} actions/cache steps, not one`);
  }
  const steps = stepsIn(workflow, "ci");
  const cache = steps.findIndex((step) =>
    /uses: actions\/cache@v\d+/.test(step.text),
  );
  const week = steps.findIndex((step) => /^ {6}- id: week$/m.test(step.text));
  if (cache === -1) {
    problems.push("ci.yml: job ci has no actions/cache step");
  } else {
    const text = steps[cache]?.text ?? "";
    const path = stepField(text, "path");
    const key = stepField(text, "key") ?? "";
    if (path !== TURBO_CACHE_DIR) {
      problems.push(`ci.yml: cache path ${path} is not ${TURBO_CACHE_DIR}`);
    }
    if (!key.includes(WEEK)) {
      problems.push(`ci.yml: cache key ${key} has no ${WEEK}`);
    }
    if (key.includes("github.sha")) {
      problems.push(`ci.yml: cache key ${key} has github.sha`);
    }
    if (/^\s+restore-keys:/m.test(text)) {
      problems.push("ci.yml: the cache step has restore-keys");
    }
    if (week === -1 || week > cache) {
      problems.push("ci.yml: no step `id: week` before the cache step");
    }
  }
  const weekRun = week === -1 ? undefined : steps[week]?.run;
  if (weekRun !== 'echo "week=$(date -u +%G-%V)" >> "$GITHUB_OUTPUT"') {
    problems.push(
      `ci.yml: the week step runs ${weekRun}, not the ISO week of date -u`,
    );
  }
  if (/pull_request_target/.test(blockOf(workflow, "on:"))) {
    problems.push(
      "ci.yml: pull_request_target runs a fork's code with the rights of the repository",
    );
  }
  const scripts = JSON.stringify(manifest.scripts ?? {});
  for (const word of NO_REMOTE) {
    if (workflow.includes(word)) problems.push(`ci.yml: has ${word}`);
    if (scripts.includes(word)) problems.push(`package.json: has ${word}`);
  }
  if (/--cache[= ]/.test(workflow)) problems.push("ci.yml: has --cache");
  for (const key of TURBO_CACHE_KEYS) {
    if (key in turbo) problems.push(`turbo.json: has ${key}`);
  }
  return problems;
}

describe("ci.yml turbo cache", () => {
  const turbo = readTurbo(".");
  const manifest = readManifest(".");
  const violations = (text: string, turboJson: Turbo = turbo) =>
    turboCacheViolations(text, turboJson, manifest);
  const replaced = (from: string, to: string) => {
    expect(workflow).toContain(from);
    return violations(workflow.replace(from, to));
  };

  const key = `key: ${"${{ runner.os }}"}-turbo-${WEEK}\n`;

  it("keeps the turbo cache of job ci by week, and nothing else", () => {
    expect(violations(workflow)).toEqual([]);
  });

  it("refuses a key without the week", () => {
    expect(replaced(key, `key: ${"${{ runner.os }}"}-turbo\n`)).toEqual([
      expect.stringContaining(`has no ${WEEK}`),
    ]);
  });

  it("refuses the commit in the key", () => {
    const commit = "${{ github.sha }}";
    expect(replaced(key, `${key.trimEnd()}-${commit}\n`)).toEqual([
      expect.stringContaining("has github.sha"),
    ]);
  });

  it.each([
    `          restore-keys: ${"${{ runner.os }}"}-turbo-${WEEK}-\n`,
    "          restore-keys: |\n            x-\n",
  ])("refuses restore keys: %j", (restore) => {
    expect(replaced(key, `${key}${restore}`)).toEqual([
      "ci.yml: the cache step has restore-keys",
    ]);
  });

  it("refuses a cache of another directory", () => {
    expect(replaced("path: .turbo/cache", "path: .turbo")).toEqual([
      expect.stringContaining("cache path .turbo is not"),
    ]);
  });

  it("refuses a week that is not the ISO week of UTC", () => {
    expect(replaced("date -u +%G-%V", "date +%Y-%W")).toEqual([
      expect.stringContaining("the week step runs"),
    ]);
  });

  it("refuses a second actions/cache step", () => {
    const second =
      "      - uses: actions/cache@v4\n        with: { path: x, key: y }\n";
    expect(
      violations(
        workflow.replace(
          "      - run: pnpm lint\n",
          `${second}      - run: pnpm lint\n`,
        ),
      ),
    ).toEqual([expect.stringContaining("2 actions/cache steps")]);
  });

  it.each(["actions/cache/save@v4", "actions/cache/restore@v4"])(
    "refuses a second step of %s",
    (action) => {
      const second = `      - uses: ${action}\n        with: { path: x, key: y }\n`;
      expect(
        violations(
          workflow.replace(
            "      - run: pnpm test\n",
            `      - run: pnpm test\n${second}`,
          ),
        ),
      ).toEqual([expect.stringContaining("2 actions/cache steps")]);
    },
  );

  it("refuses --no-cache, in the workflow and in the scripts", () => {
    const flag = "--no-cache";
    const text = workflow.replace(
      "run: pnpm test\n",
      `run: pnpm test ${flag}\n`,
    );
    const scripts = {
      ...manifest,
      scripts: { test: `turbo run test ${flag}` },
    };

    expect(violations(text)).toContainEqual(`ci.yml: has ${flag}`);
    expect(turboCacheViolations(workflow, turbo, scripts)).toEqual([
      `package.json: has ${flag}`,
    ]);
  });

  it("refuses the cache step replaced by actions/cache/restore", () => {
    expect(
      replaced("- uses: actions/cache@v4", "- uses: actions/cache/restore@v4"),
    ).toEqual(["ci.yml: job ci has no actions/cache step"]);
  });

  it("refuses a cache step outside job ci", () => {
    const text = workflow.replace(
      /( {6}- id: week\n.*\n {6}- uses: actions\/cache@v4\n(?: {8}.*\n)+)/,
      "",
    );
    const moved = `${text}      - uses: actions/cache@v4\n`;
    expect(text).not.toContain("actions/cache");
    expect(violations(moved)).toEqual([
      "ci.yml: job ci has no actions/cache step",
      expect.stringContaining("the week step runs undefined"),
    ]);
  });

  it("refuses a week step after the cache step", () => {
    const step =
      '      - id: week\n        run: echo "week=$(date -u +%G-%V)" >> "$GITHUB_OUTPUT"\n';
    const lint = "      - run: pnpm lint\n";
    expect(workflow).toContain(step);
    const moved = workflow.replace(step, "").replace(lint, `${step}${lint}`);

    expect(violations(moved)).toEqual([
      "ci.yml: no step `id: week` before the cache step",
    ]);
  });

  it("refuses pull_request_target", () => {
    expect(replaced("  pull_request:\n", "  pull_request_target:\n")).toEqual([
      expect.stringContaining("pull_request_target"),
    ]);
  });

  it.each(NO_REMOTE)("refuses %s in the workflow", (word) => {
    expect(
      violations(
        workflow.replace("run: pnpm test\n", `run: pnpm test ${word}\n`),
      ),
    ).toContainEqual(`ci.yml: has ${word}`);
  });

  it.each([
    ["remoteCache", { enabled: true }],
    ["cacheDir", ".cache/turbo"],
  ])("refuses %s in turbo.json", (name, value) => {
    const broken: Turbo = { ...turbo, [name]: value };
    expect(violations(workflow, broken)).toEqual([`turbo.json: has ${name}`]);
  });

  it.each([
    ["TURBO_FORCE: true", "TURBO_FORCE"],
    ["TURBO_CACHE: local:r", "TURBO_CACHE"],
    ["TURBO_CACHE_DIR: /tmp/t", "TURBO_CACHE"],
  ])("refuses %s in the env of the workflow", (variable, word) => {
    const text = workflow.replace(
      "permissions:\n",
      `env:\n  ${variable}\n\npermissions:\n`,
    );
    expect(violations(text)).toContainEqual(`ci.yml: has ${word}`);
  });
});

describe("ci.yml conditions", () => {
  it.each(["ci", "docker-build"])(
    "runs job %s and every step of it unconditionally",
    (job) => {
      const header = blockOf(workflow, `  ${job}:`)
        .split("\n")
        .filter((line) => /^ {4}if:/.test(line));
      const steps = stepsOf(job);

      expect(header).toEqual([]);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((step) => step.if !== undefined)).toEqual([]);
    },
  );
});

describe("ci.yml image matrix", () => {
  it("builds and probes every image the repository has a Dockerfile for", () => {
    const listed = /matrix:\s*\n\s+image:\s*\[([^\]]*)\]/.exec(workflow)?.[1];
    const matrix = (listed ?? "")
      .split(",")
      .map((name) => name.trim())
      .sort();
    const runs = stepsOf("docker-build").map((step) => step.run);

    expect(matrix).toEqual(imagesOf());
    expect(runs).toContain("node scripts/probe-image.mjs ${{ matrix.image }}");
  });

  it("builds the stage Compose runs and sets up node 22 for the probe", () => {
    const steps = stepsOf("docker-build");
    const build = steps.find((step) => step.run?.startsWith("docker build"));
    const setup = steps.find((step) =>
      step.text.includes("actions/setup-node"),
    );

    expect(build?.run).toContain("--target runtime ");
    expect(setup?.text).toMatch(/node-version: 22\b/);
    expect(steps.indexOf(setup as Step)).toBeLessThan(
      steps.indexOf(build as Step),
    );
  });
});
