import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ROOT, imagesOf } from "./dockerfile.js";

/**
 * What the CI configuration must keep, without a run of Actions to find out:
 * the triggers and the concurrency rule, the services, the steps and their
 * order, the image matrix, the absence of any turbo cache in the workflow, and
 * what the turbo hash of a package's tests covers. Next to the other tests of
 * how the repository is built and run (container.test.ts,
 * compose-rules.test.ts); every file read here is an input of the `test` task
 * of this package (turbo.json, ./turbo.json).
 */
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
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
    .parse(JSON.parse(read(".claude/hooks/rules.sf.json")))
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

  it("keeps no turbo cache in the workflow: every run computes the result", () => {
    expect(workflow).not.toMatch(/\.turbo/);
    expect(workflow).not.toMatch(/--force\b/);
    expect(workflow).not.toMatch(/--cache[= ]/);
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
    const Manifest = z.object({
      scripts: z.object({ "db:migrate": z.string() }),
    });
    const script = Manifest.parse(JSON.parse(read("packages/db/package.json")))
      .scripts["db:migrate"];

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

/**
 * The turbo hash of a package's tests (the local cache) is only as good as its
 * inputs: a file that changes the result of a task but not its hash gives a
 * green local run from the cache while the code is red
 * (docs/TECH_DEBT.md, rows closed by E0-12). CI keeps no cache of its own.
 */
describe("turbo cache hash", () => {
  const TaskSchema = z.object({
    dependsOn: z.array(z.string()).optional(),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
  });
  const TurboSchema = z.object({
    globalDependencies: z.array(z.string()).optional(),
    extends: z.array(z.string()).optional(),
    tasks: z.record(TaskSchema),
  });
  const root = TurboSchema.parse(JSON.parse(read("turbo.json")));
  const worker = TurboSchema.parse(JSON.parse(read("apps/worker/turbo.json")));

  it("includes tsconfig.base.json, which every package's typecheck extends", () => {
    expect(root.globalDependencies).toContain("tsconfig.base.json");
  });

  // The test of a package hashes the files of its internal dependencies
  // through these nodes (docs/TECH_DEBT.md, the worker#test row).
  it("makes test depend on the test of the internal dependencies", () => {
    expect(root.tasks.test?.dependsOn).toContain("^test");
  });

  it("keeps the inherited inputs in the tests of the packages that add their own", () => {
    for (const file of ["apps/worker/turbo.json", "packages/db/turbo.json"]) {
      const inputs = TurboSchema.parse(JSON.parse(read(file))).tasks.test
        ?.inputs;

      expect(inputs, file).toContain("$TURBO_EXTENDS$");
    }
  });

  it("hashes for the tests of this package every repository file they read", () => {
    expect(worker.extends).toEqual(["//"]);
    const inputs = [
      ...(root.tasks.test?.inputs ?? []),
      ...(worker.tasks.test?.inputs ?? []),
    ];
    for (const file of [
      ".github/workflows/ci.yml",
      "turbo.json",
      "package.json",
      ".env.test",
      ".env.example",
      "apps/api/package.json",
      "packages/db/package.json",
      "scripts/probe-image.mjs",
      "scripts/probe-image.d.mts",
      "scripts/compose-rules.mjs",
      "scripts/compose-rules.d.mts",
      ".dockerignore",
      "infra/docker/**",
      ".claude/hooks/rules.sf.json",
      "packages/db/turbo.json",
    ]) {
      expect(inputs).toContain(`$TURBO_ROOT$/${file}`);
    }
  });

  // What only the tests of this package read stays in ./turbo.json: in the
  // root list it would reset the test cache of every package.
  it("keeps the files only this package reads out of the inputs of every package", () => {
    const allowed = [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/.env.test",
      "$TURBO_ROOT$/.env.example",
    ];
    const shared = (root.tasks.test?.inputs ?? []).filter(
      (input) => !allowed.includes(input),
    );

    expect(shared).toEqual([]);
  });

  // api and worker integration tests share one Postgres and one Redis (db 1:
  // the heartbeat key, system.dlq); two at a time make CI flap.
  it("runs the integration tests of the packages one at a time", () => {
    const Manifest = z.object({ scripts: z.record(z.string()) });
    const script = Manifest.parse(JSON.parse(read("package.json"))).scripts[
      "test:int"
    ];

    expect(script).toMatch(/^turbo run test:int(?: \S+)*$/);
    expect(script?.match(/--concurrency\S*/g)).toEqual(["--concurrency=1"]);
  });

  it("stores the build without the cache of Next", () => {
    expect(root.tasks.build?.outputs).toContain(".next/**");
    expect(root.tasks.build?.outputs).toContain("!.next/cache/**");
  });

  it("is pinned at or above 2.10, the turbo whose hashing E0-12 checked", () => {
    const ManifestSchema = z.object({
      devDependencies: z.object({ turbo: z.string() }),
    });
    const { turbo } = ManifestSchema.parse(
      JSON.parse(read("package.json")),
    ).devDependencies;
    const lower = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(turbo);

    expect(lower, `turbo range "${turbo}"`).not.toBeNull();
    const [major = 0, minor = 0] = (lower ?? []).slice(1).map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(2 * 1000 + 10);
  });
});
