import { parseEnv } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { imageTag } from "../scripts/probe-image.mjs";
import { APP_DOCKERFILE, imagesOf } from "./dockerfile.js";
import {
  type Manifest,
  type Turbo,
  parseRepoYaml,
  readManifest,
  readRepoFile,
  readRepoJson,
  readTurbo,
} from "./repo-files.js";
import {
  type Event,
  type Step,
  type Workflow,
  ciWorkflowText,
  evaluate,
  jobIn,
  parseWorkflow,
  pullRequest,
  push,
  stepsIn,
} from "./workflow.js";

/**
 * What the CI configuration must keep, without a run of Actions to find out:
 * the triggers and the concurrency rule, the services, the steps and their
 * order, the image matrix, and the one turbo cache of the workflow - the
 * local cache of job ci, one archive per ISO week, never a remote one. What
 * the turbo hash of a task covers is `turbo-inputs.test.ts`. A test of the
 * root project, next to the other tests of how the repository is built and
 * run (container.test.ts, compose-rules.test.ts); `//#test:repo` hashes every
 * file of the repository git does not ignore - tracked, or untracked and not
 * ignored, the set `repoFilesUnder` lists - so each file read here is in its
 * hash.
 *
 * The workflow is read by `test/workflow.ts`, the Compose file by
 * `parseRepoYaml` (`test/repo-files.ts`): both fail-closed, by the one
 * reading of `yaml` of the root project (`scripts/lib/yaml-doc.mjs`,
 * decision R2 of E0-12N).
 */
const read = readRepoFile;

/** The text of ci.yml, read before the first case (`ciWorkflowText`). */
let workflow = "";
beforeAll(() => {
  workflow = ciWorkflowText();
});

/** The steps of a job of the workflow, in order. */
const stepsOf = (job: string): Step[] => stepsIn(workflow, job);

/** The step whose command runs the entry of `pnpm db:migrate`. */
const isMigrate = (step: Step) =>
  step.run?.includes("src/cli/migrate.ts") === true;

/** The steps that turn CI red on a schema change without its migration. */
const GENERATE = "pnpm --filter @sf/db db:generate < /dev/null";
const isGenerate = (step: Step) => step.run?.includes(GENERATE) === true;
const isDriftCheck = (step: Step) =>
  step.run?.includes("git status --porcelain -- packages/db/migrations") ===
  true;
const isDbCheck = (step: Step) => step.run === "pnpm --filter @sf/db db:check";

/** The value of `key` in the top-level `concurrency:` of a text of ci.yml. */
function workflowValue(
  key: "group" | "cancel-in-progress",
  text: string = workflow,
): string {
  const value = parseWorkflow(text).concurrency?.[key];
  if (typeof value !== "string" || !value.includes("${{")) {
    throw new Error(`no expression at "${key}"`);
  }
  return value;
}

describe("ci.yml triggers", () => {
  it("runs on pushes to main and on pull requests, and on nothing else", () => {
    expect(parseWorkflow(workflow).on).toEqual({
      push: { branches: ["main"] },
      pull_request: null,
    });
  });
});

describe("ci.yml permissions and time limits", () => {
  it("grants the token read access to the contents and nothing more", () => {
    const parsed = parseWorkflow(workflow);
    expect(parsed.permissions).toEqual({ contents: "read" });
    for (const job of ["ci", "docker-build"]) {
      expect(parsed.jobs[job], job).toBeDefined();
      expect(parsed.jobs[job], job).not.toHaveProperty("permissions");
    }
  });

  it.each(["ci", "docker-build"])("bounds the run of job %s", (job) => {
    const limit = jobIn(workflow, job)["timeout-minutes"];

    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(60);
  });
});

describe("ci.yml concurrency", () => {
  const group = (event: Event) => evaluate(workflowValue("group"), event);
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

/**
 * Every gate of `rules.sf.json` has a step of job ci running its command as
 * it is written there, `pnpm` tasks included: a gate the hook runs locally
 * and CI does not is a red that only one side sees.
 */
function gateViolations(
  gates: readonly string[],
  runs: readonly (string | undefined)[],
): string[] {
  return gates
    .filter((cmd) => !runs.includes(cmd))
    .map((cmd) => `ci.yml: job ci has no step running the gate "${cmd}"`);
}

describe("ci.yml job ci", () => {
  let steps: Step[] = [];
  let runs: (string | undefined)[] = [];
  beforeAll(() => {
    steps = stepsOf("ci");
    runs = steps.map((step) => step.run);
  });

  it("has Postgres and Redis on the ports and database of .env.test", () => {
    const env = parseEnv(read(".env.test"));
    const database = new URL(env.DATABASE_URL ?? "");
    const redis = new URL(env.REDIS_URL ?? "");
    const services = jobIn(workflow, "ci").services ?? {};
    const postgres = services.postgres;
    const redisService = services.redis;

    expect(postgres?.ports).toContain(`${database.port}:5432`);
    expect(postgres?.env).toMatchObject({
      POSTGRES_USER: database.username,
      POSTGRES_PASSWORD: database.password,
      POSTGRES_DB: database.pathname.replace(/^\//, ""),
    });
    expect(postgres?.options).toContain("--health-cmd");
    expect(redisService?.ports).toContain(`${redis.port}:6379`);
    expect(redisService?.options).toContain("--health-cmd");
  });

  it("installs, lints, typechecks, tests, checks the migrations, migrates, runs the integration tests and builds, in that order", () => {
    const order: ((step: Step) => boolean)[] = [
      (step) => step.run === "pnpm install --frozen-lockfile",
      (step) => step.run === "pnpm lint",
      (step) => step.run === "pnpm typecheck",
      (step) => step.run === "pnpm test",
      isGenerate,
      isMigrate,
      (step) => step.run === "pnpm test:int",
      (step) => step.run === "pnpm build",
    ];
    const at = order.map((matches) => steps.findIndex(matches));

    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  const GateSchema = z.object({ cmd: z.string() });
  const gates = z
    .object({ gates: z.array(GateSchema) })
    .parse(readRepoJson(".claude/hooks/rules.sf.json"))
    .gates.map((gate) => gate.cmd);
  // The gates that are not `pnpm` tasks: those have their places above.
  const scriptGates = gates.filter((cmd) => !cmd.startsWith("pnpm "));

  it("runs every gate of .claude/hooks/rules.sf.json, pnpm tasks included", () => {
    expect(gates.length).toBeGreaterThanOrEqual(9);
    expect(gateViolations(gates, runs)).toEqual([]);
  });

  it("is red on a gate job ci does not run, pnpm task or not", () => {
    expect(gateViolations([...gates, "pnpm foo", "node x.mjs"], runs)).toEqual([
      'ci.yml: job ci has no step running the gate "pnpm foo"',
      'ci.yml: job ci has no step running the gate "node x.mjs"',
    ]);
  });

  it("runs the gates that are not pnpm tasks after the tests and before the migration", () => {
    const test = runs.indexOf("pnpm test");
    const migrate = steps.findIndex(isMigrate);

    expect(scriptGates.length).toBeGreaterThanOrEqual(4);
    for (const cmd of scriptGates) {
      const at = runs.indexOf(cmd);
      expect(at, cmd).toBeGreaterThan(test);
      expect(at, cmd).toBeLessThan(migrate);
    }
  });

  it("checks the Compose files with the pinned Compose, verified by its checksum", () => {
    const install = steps.findIndex(isComposeInstall);
    const script = steps[install]?.run ?? "";
    const version = /\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(
      script,
    )?.[1];

    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(
      runs.indexOf("node scripts/check-compose.mjs"),
    );
    expect(version).toBe("5.5.1");
    expect(composeInstallViolations(script)).toEqual([]);
    expect(script).toContain(
      `test "$(docker compose version --short)" = "${version}"`,
    );
  });

  it("caches the pnpm store through setup-node", () => {
    const setup = steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );

    expect(setup?.with?.["node-version"]).toBe(22);
    expect(setup?.with?.cache).toBe("pnpm");
  });

  it("migrates with the entry of `pnpm db:migrate` and .env.test as a dotenv file", () => {
    expect(migrateStepViolations(steps)).toEqual([]);
  });

  /**
   * A schema change without its migration: generate writes the missing
   * migration, the porcelain of the folder - untracked files included - must
   * stay empty, and drizzle-kit checks the folder itself. Generate and check
   * start drizzle-kit the one way the bypass of `db:generate` does (decision
   * R4 of E0-12C), so the step breaks with it.
   */
  it("checks that the migrations match the schema", () => {
    const generate = steps.findIndex(isGenerate);
    const drift = steps.findIndex(isDriftCheck);
    const check = steps.findIndex(isDbCheck);
    const install = runs.indexOf("pnpm install --frozen-lockfile");
    const integration = runs.indexOf("pnpm test:int");
    const scripts = readManifest("packages/db").scripts ?? {};
    const bypass = "tsx ./node_modules/drizzle-kit/bin.cjs ";

    expect([install, generate, drift, check, integration]).not.toContain(-1);
    expect(install).toBeLessThan(generate);
    expect(generate).toBeLessThan(drift);
    expect(drift).toBeLessThan(check);
    expect(check).toBeLessThan(integration);
    expect(steps[drift]?.run).toContain('test -z "$drift" || {');
    expect(scripts["db:generate"]).toBe(`${bypass}generate`);
    expect(scripts["db:check"]).toBe(`${bypass}check`);
  });

  /**
   * An ambiguous rename makes generate ask a question: with stdin open it
   * waits for the answer, with stdin at its end it gives up and exits with 0
   * having written nothing. The step closes stdin, is bounded, and fails
   * unless generate printed one of the lines it finishes with.
   */
  it("fails generate fast when it stopped at a question", () => {
    const step = steps.find(isGenerate);
    const script = step?.run ?? "";

    expect(step?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(script).toContain("set -o pipefail");
    expect(script).toContain(`${GENERATE} 2>&1 | tee "$log"`);
    expect(script).toContain(
      'grep -qE "No schema changes, nothing to migrate|Your SQL migration file" "$log" || {',
    );
    expect(script).toMatch(/\|\| \{\n[^}]*\n\s+exit 1\n\s*\}/);
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

/** The action of `actions/cache` the cache step uses: a major tag or a commit. */
const CACHE_ACTION = /^actions\/cache@(?:v\d+|[0-9a-f]{40})$/;

/**
 * The words of a command or a value: a flag with its value (`--cache=x`)
 * gives the flag, `${{ secrets.TURBO_TOKEN }}` gives `TURBO_TOKEN`.
 */
function wordsOf(text: string): string[] {
  return text.split(/[^\w-]+/).filter((word) => word !== "");
}

/**
 * Whether a word of a command, a script or an environment is `name` of
 * `NO_REMOTE`: the flag itself, the variable itself, or a variable of its
 * family (`TURBO_CACHE_DIR` of `TURBO_CACHE`, `TURBO_REMOTE_ONLY` of
 * `TURBO_REMOTE_`).
 */
function isWord(word: string, name: string): boolean {
  if (name.startsWith("-")) return word === name;
  return (
    word === name || word.startsWith(name.endsWith("_") ? name : `${name}_`)
  );
}

/**
 * Where a map sits in the workflow: the maps whose `name:` is a label - the
 * workflow, a job, a step - and the places on the way to them.
 */
type Place = "workflow" | "jobs" | "job" | "steps" | "step" | "value";

/** The place of the value under `key` of a map at `place`. */
function placeUnder(place: Place, key: string): Place {
  if (place === "workflow" && key === "jobs") return "jobs";
  if (place === "jobs") return "job";
  if (place === "job" && key === "steps") return "steps";
  return "value";
}

/** The maps whose `name:` is a label, not a value handed on. */
const LABELLED: ReadonlySet<Place> = new Set(["workflow", "job", "step"]);

/**
 * Every word of the workflow as parsed: each key and each value, at any
 * depth - the commands of the steps, the `env:` of the workflow, its jobs,
 * their containers, services and steps, the `with:` and `secrets:` handed to
 * an action or a workflow, the conditions, the options of a service. Only
 * the `name:` of the workflow, of a job and of a step is a label and not
 * read; a `name:` anywhere else (`env:`, `with:`, `secrets:`) is a value
 * handed on, and is. Comments are not in the tree.
 */
function workflowWordsOf(value: unknown, place: Place = "workflow"): string[] {
  if (typeof value === "string") return wordsOf(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return wordsOf(String(value));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      workflowWordsOf(item, place === "steps" ? "step" : "value"),
    );
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "name" && typeof item === "string" && LABELLED.has(place)
      ? []
      : [...wordsOf(key), ...workflowWordsOf(item, placeUnder(place, key))],
  );
}

/**
 * Every way the CI configuration could break the cache of turbo, one line
 * each; empty when clean. The archive of `.turbo/cache` is one per ISO week,
 * kept by the one job that runs the tasks: no commit in the key and no
 * restore keys, so a run never saves a grown copy of the archive it
 * restored. Nothing reaches a remote cache, and nothing makes a task skip
 * the cache it has - read from every key and value of the workflow
 * (`workflowWordsOf`) and the scripts of the root manifest, not from comments
 * or the names of steps.
 * `workflow` is the text of ci.yml, `turbo` and `manifest` the root
 * turbo.json and package.json as parsed.
 */
function turboCacheViolations(
  workflow: string,
  turbo: Turbo,
  manifest: Manifest,
): string[] {
  const problems: string[] = [];
  const parsed = parseWorkflow(workflow);
  const allSteps = Object.values(parsed.jobs).flatMap((job) => job.steps);
  // Every action of actions/cache counts, `cache/save` and `cache/restore`
  // too: a second step that saves would grow the archive again.
  const uses = allSteps.filter((step) =>
    /^actions\/cache(?:\/[\w-]+)?@/i.test(step.uses ?? ""),
  );
  if (uses.length !== 1) {
    problems.push(`ci.yml: ${uses.length} actions/cache steps, not one`);
  }
  const steps = parsed.jobs.ci?.steps ?? [];
  const cache = steps.findIndex((step) => CACHE_ACTION.test(step.uses ?? ""));
  const week = steps.findIndex((step) => step.id === "week");
  if (cache === -1) {
    problems.push("ci.yml: job ci has no actions/cache step");
  } else {
    const options = steps[cache]?.with ?? {};
    const path = options.path;
    const key = String(options.key ?? "");
    if (path !== TURBO_CACHE_DIR) {
      problems.push(`ci.yml: cache path ${path} is not ${TURBO_CACHE_DIR}`);
    }
    if (!key.includes(WEEK)) {
      problems.push(`ci.yml: cache key ${key} has no ${WEEK}`);
    }
    if (key.includes("github.sha")) {
      problems.push(`ci.yml: cache key ${key} has github.sha`);
    }
    if ("restore-keys" in options) {
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
  if (Object.hasOwn(parsed.on, "pull_request_target")) {
    problems.push(
      "ci.yml: pull_request_target runs a fork's code with the rights of the repository",
    );
  }
  const workflowWords = workflowWordsOf(parsed);
  const scriptWords = Object.values(manifest.scripts ?? {}).flatMap(wordsOf);
  for (const name of NO_REMOTE) {
    if (workflowWords.some((word) => isWord(word, name))) {
      problems.push(`ci.yml: has ${name}`);
    }
    if (scriptWords.some((word) => isWord(word, name))) {
      problems.push(`package.json: has ${name}`);
    }
  }
  if (workflowWords.includes("--cache")) problems.push("ci.yml: has --cache");
  if (scriptWords.includes("--cache")) {
    problems.push("package.json: has --cache");
  }
  for (const key of TURBO_CACHE_KEYS) {
    if (key in turbo) problems.push(`turbo.json: has ${key}`);
  }
  return problems;
}

describe("ci.yml turbo cache", () => {
  // Read before the first case rather than when the file is collected: a
  // file that cannot be read is then a red case with its reason.
  let turbo: Turbo;
  let manifest: Manifest;
  beforeAll(() => {
    turbo = readTurbo(".");
    manifest = readManifest(".");
  });
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

  it("takes the cache action pinned to a commit", () => {
    expect(
      replaced(
        "- uses: actions/cache@v4",
        "- uses: actions/cache@0c45773b623bea8c8e75f6c82b208c3cf94ea4f9",
      ),
    ).toEqual([]);
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

  it.each(["--cache=local:", "--cache local:r"])(
    "refuses %s in a script of the root manifest",
    (flag) => {
      const scripts = {
        ...manifest,
        scripts: { test: `turbo run test ${flag}` },
      };

      expect(turboCacheViolations(workflow, turbo, scripts)).toEqual([
        "package.json: has --cache",
      ]);
    },
  );

  it("refuses --cache in a command of the workflow", () => {
    expect(
      replaced("run: pnpm test\n", "run: pnpm test --cache=local:r\n"),
    ).toEqual(["ci.yml: has --cache"]);
  });

  it("does not take a word of a comment or of the name of a step for a command", () => {
    const text = workflow
      .replace(
        "      - run: pnpm lint\n",
        "      # pnpm test --force, TURBO_TOKEN, --cache=remote:\n      - run: pnpm lint\n",
      )
      .replace(
        "- name: Build image\n",
        "- name: Build image without --force or TURBO_CACHE\n",
      );
    expect(text).not.toBe(workflow);

    expect(violations(text)).toEqual([]);
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
    ["TOKEN: ${{ secrets.TURBO_TOKEN }}", "TURBO_TOKEN"],
  ])("refuses %s in the env of the workflow", (variable, word) => {
    const text = workflow.replace(
      "permissions:\n",
      `env:\n  ${variable}\n\npermissions:\n`,
    );
    expect(violations(text)).toContainEqual(`ci.yml: has ${word}`);
  });

  it.each([
    [
      "the with of an action",
      "      - run: pnpm test\n",
      "      - run: pnpm test\n      - uses: docker/build-push-action@v6\n        with:\n          build-args: TURBO_TOKEN=x\n",
      "TURBO_TOKEN",
    ],
    [
      "a condition of a step",
      "      - run: pnpm test\n",
      "      - run: pnpm test\n        if: ${{ env.TURBO_TEAM != '' }}\n",
      "TURBO_TEAM",
    ],
    [
      "the env of a container of the job",
      "    runs-on: ubuntu-latest\n",
      "    runs-on: ubuntu-latest\n    container:\n      image: node:22\n      env:\n        TURBO_API: https://cache.example\n",
      "TURBO_API",
    ],
    [
      "the options of a service",
      "      postgres:\n",
      "      cache:\n        image: x\n        options: --env TURBO_REMOTE_ONLY=true\n      postgres:\n",
      "TURBO_REMOTE_",
    ],
    [
      "the inputs of a trigger",
      "  pull_request:\n",
      "  pull_request:\n  workflow_dispatch:\n    inputs:\n      TURBO_TOKEN:\n        type: string\n",
      "TURBO_TOKEN",
    ],
    [
      "a name: of the env of a step",
      "      - run: pnpm test\n",
      "      - run: pnpm test\n        env:\n          name: ${{ secrets.TURBO_TOKEN }}\n",
      "TURBO_TOKEN",
    ],
    [
      "a name: of the with of an action",
      "      - run: pnpm test\n",
      "      - run: pnpm test\n      - uses: docker/build-push-action@v6\n        with:\n          name: ${{ secrets.TURBO_TOKEN }}\n",
      "TURBO_TOKEN",
    ],
    [
      "a name: of the env of the job",
      "    runs-on: ubuntu-latest\n",
      "    runs-on: ubuntu-latest\n    env:\n      name: ${{ secrets.TURBO_TEAM }}\n",
      "TURBO_TEAM",
    ],
    [
      "a name: of the env of a container of the job",
      "    runs-on: ubuntu-latest\n",
      "    runs-on: ubuntu-latest\n    container:\n      image: node:22\n      env:\n        name: ${{ secrets.TURBO_API }}\n",
      "TURBO_API",
    ],
  ])("refuses a word of NO_REMOTE in %s", (_where, from, to, word) => {
    expect(replaced(from, to)).toContainEqual(`ci.yml: has ${word}`);
  });

  it("reads a name: of the secrets handed to a reusable workflow", () => {
    const words = workflowWordsOf({
      jobs: {
        reuse: {
          uses: "./.github/workflows/other.yml",
          secrets: { name: "${{ secrets.TURBO_TOKEN }}" },
        },
      },
    });

    expect(words).toContain("TURBO_TOKEN");
  });

  it("leaves out the name: of the workflow, of a job and of a step only", () => {
    const words = workflowWordsOf({
      name: "TURBO_TOKEN",
      jobs: {
        ci: {
          name: "TURBO_TEAM",
          steps: [{ name: "TURBO_API", run: "pnpm test" }],
        },
      },
    });

    expect(words).not.toContain("TURBO_TOKEN");
    expect(words).not.toContain("TURBO_TEAM");
    expect(words).not.toContain("TURBO_API");
    expect(words).toContain("pnpm");
  });

  it("refuses TURBO_CACHE in the env of a step", () => {
    expect(
      replaced(
        "      - run: pnpm test\n",
        "      - run: pnpm test\n        env: { TURBO_CACHE: 'local:r' }\n",
      ),
    ).toEqual(["ci.yml: has TURBO_CACHE"]);
  });
});

describe("ci.yml conditions", () => {
  it.each(["ci", "docker-build"])(
    "runs job %s and every step of it unconditionally",
    (job) => {
      const parsed = jobIn(workflow, job);

      expect(parsed.if).toBeUndefined();
      expect(parsed.steps.length).toBeGreaterThan(0);
      expect(parsed.steps.filter((step) => step.if !== undefined)).toEqual([]);
    },
  );
});

/** The image matrix of job docker-build, sorted; a matrix that is not a list of names throws. */
function matrixOf(text: string): string[] {
  const matrix = jobIn(text, "docker-build").strategy?.matrix ?? {};
  return z.array(z.string()).parse(matrix.image).sort();
}

/**
 * How job docker-build strays from the one Dockerfile and its probe, one line
 * each; empty when clean: buildx set up, one build of the matrix target of
 * `APP_DOCKERFILE` loaded into the engine under the tag the probe runs by
 * default (`imageTag`), the layer cache of GitHub Actions in a scope of the
 * target both ways - its export failing does not fail the build
 * (`ignore-error=true`) - no `build-args` (the node image is the one
 * `app.Dockerfile` names, E0-12J), and node 22 set up before the build for
 * the probe.
 */
function dockerBuildViolations(text: string): string[] {
  const steps = stepsIn(text, "docker-build");
  const target = "${{ matrix.image }}";
  const build = steps.findIndex(
    (step) => step.uses === "docker/build-push-action@v6",
  );
  if (build === -1) {
    return ["docker-build: no docker/build-push-action@v6 step"];
  }
  const problems: string[] = [];
  const buildx = steps.findIndex(
    (step) => step.uses === "docker/setup-buildx-action@v3",
  );
  const setup = steps.findIndex(
    (step) =>
      step.uses?.startsWith("actions/setup-node@") === true &&
      step.with?.["node-version"] === 22,
  );
  if (buildx === -1 || buildx > build) {
    problems.push("docker-build: buildx is not set up before the build");
  }
  if (setup === -1 || setup > build) {
    problems.push("docker-build: setup-node does not come before the build");
  }
  const options = steps[build]?.with ?? {};
  const expected: Record<string, string> = {
    context: ".",
    file: APP_DOCKERFILE,
    target,
    tags: imageTag(target),
    load: "true",
    "cache-from": `type=gha,scope=${target}`,
    "cache-to": `type=gha,mode=max,scope=${target},ignore-error=true`,
  };
  for (const [key, value] of Object.entries(expected)) {
    const found = options[key] === undefined ? undefined : String(options[key]);
    if (found !== value) {
      problems.push(`docker-build: ${key} is ${found}, not ${value}`);
    }
  }
  if ("build-args" in options) {
    problems.push("docker-build: the build passes build-args");
  }
  return problems;
}

describe("ci.yml image matrix", () => {
  it("builds and probes every target of app.Dockerfile", () => {
    const runs = stepsOf("docker-build").map((step) => step.run);

    expect(matrixOf(workflow)).toEqual(imagesOf());
    expect(runs).toContain("node scripts/probe-image.mjs ${{ matrix.image }}");
  });

  it("builds the target Compose runs, cached by target, and sets up node 22 for the probe", () => {
    expect(dockerBuildViolations(workflow)).toEqual([]);
  });

  it.each([
    ["file: infra/docker/app.Dockerfile", "file: infra/docker/api.Dockerfile"],
    ["target: ${{ matrix.image }}", "target: runtime"],
    ["          load: true\n", ""],
    ["tags: sf-${{ matrix.image }}:ci", "tags: sf-${{ matrix.image }}:latest"],
    ["cache-from: type=gha,scope=${{ matrix.image }}", "cache-from: type=gha"],
    [
      "cache-to: type=gha,mode=max,scope=${{ matrix.image }},",
      "cache-to: type=gha,mode=max,scope=all,",
    ],
    [",ignore-error=true\n", "\n"],
    [",ignore-error=true\n", ",ignore-error=false\n"],
    ["cache-to: type=gha,mode=max,", "cache-to: type=registry,mode=max,"],
    ["uses: docker/build-push-action@v6", "uses: docker/build-push-action@v5"],
    ["      - uses: docker/setup-buildx-action@v3\n", ""],
    [
      "          load: true\n",
      "          load: true\n          build-args: NODE_IMAGE=node:20-alpine\n",
    ],
    [
      "          load: true\n",
      "          load: true\n          build-args: |\n            NODE_IMAGE=node:20-alpine\n",
    ],
  ])("is red when %j becomes %j", (from, to) => {
    expect(workflow).toContain(from);

    expect(dockerBuildViolations(workflow.replace(from, to))).toHaveLength(1);
  });

  it("is red on a matrix that is not the targets", () => {
    const from = "image: [api, migrate, web, worker]";
    expect(workflow).toContain(from);

    expect(
      matrixOf(workflow.replace(from, "image: [api, migrate, web]")),
    ).not.toEqual(imagesOf());
  });

  it("is red when setup-node comes after the build", () => {
    const setup =
      "      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n";
    const buildx = "      - uses: docker/setup-buildx-action@v3\n";
    const probe = "      # An image whose install put nothing in place";
    expect(workflow).toContain(`${setup}${buildx}`);
    const moved = workflow
      .replace(`${setup}${buildx}`, buildx)
      .replace(probe, `${setup}${probe}`);

    expect(dockerBuildViolations(moved)).toEqual([
      "docker-build: setup-node does not come before the build",
    ]);
  });
});

/** The text of the Compose file of Postgres and Redis. */
let compose = "";
beforeAll(() => {
  compose = read("infra/docker-compose.yml").replace(/\r\n/g, "\n");
});

/** The services of a Compose text, by the keys read here. */
const ComposeSchema = z.object({
  services: z.record(
    z
      .object({
        image: z.string().optional(),
        healthcheck: z
          .object({ test: z.array(z.string()) })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  ),
});

/** A service of a Compose text. */
function composeService(text: string, service: string) {
  const found = ComposeSchema.parse(parseRepoYaml(text, "docker-compose.yml"))
    .services[service];
  if (found === undefined) throw new Error(`no service ${service}`);
  return found;
}

/** The image of a service of a Compose text. */
function composeImage(text: string, service: string): string {
  const image = composeService(text, service).image;
  if (image === undefined) throw new Error(`no image of ${service}`);
  return image;
}

/** The command of the `CMD-SHELL` healthcheck of a service of a Compose text. */
function composeHealthShell(text: string, service: string): string {
  const [kind, command, ...rest] =
    composeService(text, service).healthcheck?.test ?? [];
  if (kind !== "CMD-SHELL" || command === undefined || rest.length > 0) {
    throw new Error(`no CMD-SHELL healthcheck of ${service}`);
  }
  return command;
}

/**
 * How the services of job ci stray from the stack of Compose, one line each;
 * empty when clean: Postgres and Redis run the images of
 * `infra/docker-compose.yml`, and the health command of Redis is the one of
 * its Compose healthcheck - the answer must be PONG, since redis-cli exits 0
 * on the LOADING of a Redis replaying its append-only file.
 */
function serviceViolations(text: string, composeText: string): string[] {
  const problems: string[] = [];
  const services = jobIn(text, "ci").services ?? {};
  for (const name of ["postgres", "redis"]) {
    const image = services[name]?.image;
    const expected = composeImage(composeText, name);
    if (image !== expected) {
      problems.push(`ci: ${name} runs ${image}, Compose runs ${expected}`);
    }
  }
  const health = /--health-cmd "(.*?)"/.exec(
    services.redis?.options ?? "",
  )?.[1];
  const expected = composeHealthShell(composeText, "redis");
  if (health !== expected) {
    problems.push(`ci: redis health is ${health}, Compose checks ${expected}`);
  }
  return problems;
}

describe("ci.yml services against Compose", () => {
  const PONG = "redis-cli ping | grep -qx PONG";

  it("runs the images and the Redis health check of infra/docker-compose.yml", () => {
    expect(serviceViolations(workflow, compose)).toEqual([]);
  });

  it.each([
    ["postgres:16-alpine", "postgres:17-alpine"],
    ["redis:7-alpine", "redis:7.4-alpine"],
    [`--health-cmd "${PONG}"`, '--health-cmd "redis-cli ping"'],
  ])("is red when %j becomes %j in ci.yml alone", (from, to) => {
    expect(workflow).toContain(from);

    expect(serviceViolations(workflow.replace(from, to), compose)).toHaveLength(
      1,
    );
  });

  it.each([
    ["image: postgres:16-alpine", "image: postgres:16"],
    ["image: redis:7-alpine", "image: redis:7"],
    [`"CMD-SHELL", "${PONG}"`, '"CMD-SHELL", "redis-cli ping"'],
  ])("is red when %j becomes %j in Compose alone", (from, to) => {
    expect(compose).toContain(from);

    expect(serviceViolations(workflow, compose.replace(from, to))).toHaveLength(
      1,
    );
  });
});

/** The step of job ci that installs the pinned Compose. */
function isComposeInstall(step: Step): boolean {
  return step.run?.includes("docker-compose-linux-x86_64") === true;
}

/**
 * How the script of the step that installs Compose would let an unchecked
 * binary in, one line each; empty when clean: it starts with
 * `set -euo pipefail`, downloads the binary to a file, checks the checksum of
 * that very file and installs that file - in that order.
 */
function composeInstallViolations(text: string): string[] {
  const problems: string[] = [];
  const script = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (script[0] !== "set -euo pipefail") {
    problems.push("compose install: does not start with set -euo pipefail");
  }
  const at = (pattern: RegExp) =>
    script.findIndex((line) => pattern.test(line));
  const curl = at(/^curl -fsSL -o /);
  const sum = at(/ \| sha256sum -c -$/);
  const install = at(/^install -m 0755 /);
  if (curl === -1 || sum === -1 || install === -1) {
    return [
      ...problems,
      "compose install: lacks curl -o, sha256sum -c or install",
    ];
  }
  if (!(curl < sum && sum < install)) {
    problems.push("compose install: not curl, then sha256sum, then install");
  }
  const unquote = (path: string | undefined) => path?.replace(/^"(.*)"$/, "$1");
  const downloaded = unquote(
    /^curl -fsSL -o (\S+) /.exec(script[curl] ?? "")?.[1],
  );
  const checked = /^echo "[0-9a-f]{64} {2}(\S+)" \| sha256sum -c -$/.exec(
    script[sum] ?? "",
  )?.[1];
  const installed = unquote(
    /^install -m 0755 (\S+) \S+$/.exec(script[install] ?? "")?.[1],
  );
  if (
    downloaded === undefined ||
    checked !== downloaded ||
    installed !== downloaded
  ) {
    problems.push(
      `compose install: downloads ${downloaded}, checks ${checked}, installs ${installed}`,
    );
  }
  return problems;
}

describe("ci.yml Compose install", () => {
  let text = "";
  beforeAll(() => {
    text = stepsOf("ci").find(isComposeInstall)?.run ?? "";
  });
  const SUM =
    "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576";

  it.each([
    ["set -euo pipefail\n", ""],
    ["set -euo pipefail", "set -eu"],
    [
      `echo "${SUM}  $RUNNER_TEMP/docker-compose"`,
      `echo "${SUM}  $RUNNER_TEMP/other"`,
    ],
    [
      'install -m 0755 "$RUNNER_TEMP/docker-compose"',
      'install -m 0755 "$RUNNER_TEMP/compose"',
    ],
    [
      'curl -fsSL -o "$RUNNER_TEMP/docker-compose"',
      'curl -fsSL -o "$HOME/.docker/cli-plugins/docker-compose"',
    ],
    [" | sha256sum -c -", " | tee /dev/null"],
  ])("is red when %j becomes %j", (from, to) => {
    expect(text).toContain(from);

    expect(composeInstallViolations(text.replace(from, to))).toHaveLength(1);
  });

  it("is red when the binary is installed before its checksum is checked", () => {
    const lines = text.split("\n");
    const sum = lines.findIndex((line) => line.includes("sha256sum -c -"));
    const install = lines.findIndex((line) => line.includes("install -m 0755"));
    const swapped = [...lines];
    swapped[sum] = lines[install] ?? "";
    swapped[install] = lines[sum] ?? "";

    expect(composeInstallViolations(swapped.join("\n"))).toEqual([
      "compose install: not curl, then sha256sum, then install",
    ]);
  });
});

/**
 * How the step that migrates the database of CI strays from `pnpm db:migrate`,
 * one line each; empty when clean: it runs the entry of the script from
 * `packages/db` with `.env.test` as its dotenv file, and sets no `env:` of its
 * own - the variables come from the file or from the runner.
 */
function migrateStepViolations(steps: Step[]): string[] {
  const step = steps.find(isMigrate);
  if (step === undefined) return ["ci: no step runs src/cli/migrate.ts"];
  const problems: string[] = [];
  const script = readManifest("packages/db").scripts?.["db:migrate"];
  if (!/^tsx \S+$/.test(script ?? "")) {
    problems.push(`packages/db: db:migrate is ${script}, not tsx <entry>`);
  }
  if (step["working-directory"] !== "packages/db") {
    problems.push("ci: the migration does not run from packages/db");
  }
  if (step.env !== undefined) {
    problems.push("ci: the migration step sets env of its own");
  }
  if (step.run !== `node --env-file=../../.env.test --import ${script}`) {
    problems.push(`ci: the migration runs ${step.run}`);
  }
  return problems;
}

describe("ci.yml migration step", () => {
  const broken = (from: string, to: string) => {
    expect(workflow).toContain(from);
    return stepsIn(workflow.replace(from, to), "ci");
  };

  it.each([
    ["working-directory: packages/db", "working-directory: ."],
    ["--env-file=../../.env.test", "--env-file=../../.env"],
    [
      "- working-directory: packages/db\n",
      "- working-directory: packages/db\n        env: { NODE_ENV: test }\n",
    ],
  ])("is red when %j becomes %j", (from, to) => {
    expect(migrateStepViolations(broken(from, to))).toHaveLength(1);
  });
});
