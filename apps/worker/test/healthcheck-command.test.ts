import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@sf/config/paths";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  workerHealthcheckOf,
  workerHealthcheckOfRepo,
} from "./healthcheck-command.js";

/**
 * The healthcheck command the integration test forks is read from Compose, not
 * written out in the test. These cases hold the reader: that it returns what
 * the file says (a changed flag comes back changed) and that every shape it
 * does not turn into flags and a script is refused with its own reason - a
 * reason is matched by its own words, never by the text of the YAML parser.
 */

/** A `compose.yaml` that includes the given files. */
function entryOf(...includes: string[]): string {
  return ["name: sf", "include:", ...includes.map((p) => `  - ${p}`), ""].join(
    "\n",
  );
}

/** A Compose file with a worker whose healthcheck `test` is the given YAML. */
function workerFile(testYaml: string, extra = ""): string {
  return [
    "services:",
    "  worker:",
    "    image: x",
    "    healthcheck:",
    `      test: ${testYaml}`,
    extra,
    "",
  ].join("\n");
}

const GOOD = '["CMD", "node", "--import", "tsx", "src/cli/healthcheck.ts"]';

function reader(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined)
      throw new Error(`no such file in the case: ${path}`);
    return text;
  };
}

function readOne(app: string): ReturnType<typeof workerHealthcheckOf> {
  return workerHealthcheckOf(
    reader({
      "compose.yaml": entryOf("infra/app.yml"),
      "infra/app.yml": app,
    }),
    "compose.yaml",
  );
}

function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every `services.worker.healthcheck.test` in `compose.yaml` and its includes. */
function composeWorkerTests(): unknown[] {
  const read = (path: string): Record<string, unknown> =>
    asMapping(parse(readFileSync(join(repoRoot, path), "utf8")));
  const include = read("compose.yaml").include;
  const files = (Array.isArray(include) ? include : []).map((item: unknown) => {
    if (typeof item !== "string") {
      throw new Error("the oracle reads only plain paths in include");
    }
    return item;
  });
  return ["compose.yaml", ...files].flatMap((path) => {
    const worker = asMapping(asMapping(read(path).services).worker);
    const test = asMapping(worker.healthcheck).test;
    return test === undefined ? [] : [test];
  });
}

/** The messages of an error and of every `cause` behind it, joined. */
function chainText(error: unknown): string {
  const texts: string[] = [];
  for (let e = error; e instanceof Error; e = e.cause) texts.push(e.message);
  return texts.join(" | ");
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, got a result");
}

describe("worker healthcheck command from Compose", () => {
  it("is read from the Compose files of this checkout", () => {
    // The oracle walks the files on its own with a plain parse - the entry
    // file, each file it includes, the one `worker.healthcheck.test` - so the
    // reader is held to the whole of what the files say, with no name of a
    // file or of the CLI written out here.
    const found = composeWorkerTests();

    expect(found).toHaveLength(1);
    const argv = found[0] as string[];
    expect(workerHealthcheckOfRepo()).toEqual({
      execArgv: argv.slice(2, -1),
      script: argv.at(-1),
    });
  });

  it("returns the flags and the script the file says", () => {
    expect(
      readOne(
        workerFile(
          '["CMD", "node", "--import", "tsx", "--no-warnings", "src/cli/healthcheck.ts"]',
        ),
      ),
    ).toEqual({
      execArgv: ["--import", "tsx", "--no-warnings"],
      script: "src/cli/healthcheck.ts",
    });
  });

  it("returns no flags when the command has none", () => {
    expect(
      readOne(workerFile('["CMD", "node", "src/cli/healthcheck.ts"]')),
    ).toEqual({ execArgv: [], script: "src/cli/healthcheck.ts" });
  });

  it("returns the script as Compose names it", () => {
    expect(
      readOne(workerFile('["CMD", "node", "--import", "tsx", "src/index.ts"]')),
    ).toEqual({ execArgv: ["--import", "tsx"], script: "src/index.ts" });
  });

  it("takes `include: null` as no include", () => {
    const entry = `${workerFile(GOOD)}include:
`;

    expect(
      workerHealthcheckOf(reader({ "compose.yaml": entry }), "compose.yaml")
        .execArgv,
    ).toEqual(["--import", "tsx"]);
  });

  it("finds the worker in the entry file itself", () => {
    const entry = `${workerFile(GOOD)}include: []\n`;

    expect(
      workerHealthcheckOf(reader({ "compose.yaml": entry }), "compose.yaml")
        .execArgv,
    ).toEqual(["--import", "tsx"]);
  });

  it("expands a merge key, as Compose does", () => {
    const app = [
      "x-env: &env",
      "  A: '1'",
      "services:",
      "  worker:",
      "    environment:",
      "      <<: *env",
      "      B: '2'",
      "    healthcheck:",
      `      test: ${GOOD}`,
      "",
    ].join("\n");

    expect(readOne(app).script).toBe("src/cli/healthcheck.ts");
  });

  it.each([
    [
      "CMD-SHELL",
      workerFile('["CMD-SHELL", "node src/cli/healthcheck.ts"]'),
      "not in the CMD form",
    ],
    [
      "a string",
      workerFile('"node src/cli/healthcheck.ts"'),
      "healthcheck.test is not an array of strings",
    ],
    [
      "an element that is not a string",
      workerFile('["CMD", "node", 5, "src/cli/healthcheck.ts"]'),
      "healthcheck.test is not an array of strings",
    ],
    ["NONE", workerFile('["NONE"]'), "not in the CMD form"],
    [
      "disable: true",
      workerFile(GOOD, "      disable: true"),
      "healthcheck of the worker is disabled",
    ],
    [
      "a program other than node",
      workerFile('["CMD", "bun", "src/cli/healthcheck.ts"]'),
      "not a node command with a script",
    ],
    [
      "no script",
      workerFile('["CMD", "node"]'),
      "not a node command with a script",
    ],
    [
      "no healthcheck",
      "services:\n  worker:\n    image: x\n",
      "service worker has no healthcheck",
    ],
    ["no worker", "services:\n  api:\n    image: x\n", "no service worker"],
    [
      "two YAML documents",
      `${workerFile(GOOD)}---\nservices: {}\n`,
      "2 YAML documents, expected one",
    ],
    [
      "a warning of the parser (a tag it does not know)",
      workerFile(GOOD, "    note: !nope y"),
      "YAML fault",
    ],
    ["a key twice", workerFile(GOOD, "    image: y"), "YAML fault"],
    ["a syntax error", "services: [\n", "YAML fault"],
    ["an empty file", "", "the file has no YAML document"],
    [
      "a merge of something that is not a map",
      "services:\n  worker:\n    <<: 5\n",
      "YAML value cannot be built",
    ],
    [
      "a flag with a space in it",
      workerFile('["CMD", "node", "--a b", "src/cli/healthcheck.ts"]'),
      "element 2 is empty or holds a space",
    ],
    [
      "an empty element",
      workerFile('["CMD", "node", "", "src/cli/healthcheck.ts"]'),
      "element 2 is empty or holds a space",
    ],
    [
      "a null test",
      workerFile("null"),
      "healthcheck.test is not an array of strings (it is null)",
    ],
    [
      "a healthcheck without test",
      "services:\n  worker:\n    healthcheck:\n      interval: 5s\n",
      "healthcheck.test is not an array of strings (it is missing)",
    ],
  ])("refuses %s", (_case, app, reason) => {
    expect(() => readOne(app)).toThrow(reason);
  });

  it("refuses a worker in two files", () => {
    const files = reader({
      "compose.yaml": entryOf("infra/a.yml", "infra/b.yml"),
      "infra/a.yml": workerFile(GOOD),
      "infra/b.yml": workerFile(GOOD),
    });

    expect(() => workerHealthcheckOf(files, "compose.yaml")).toThrow(
      "service worker is in 2 Compose files",
    );
  });

  it("refuses an include that is not a plain path", () => {
    const entry = "include:\n  - path: infra/app.yml\n";

    expect(() =>
      workerHealthcheckOf(reader({ "compose.yaml": entry }), "compose.yaml"),
    ).toThrow("include form is not a plain path");
  });

  it("refuses an include that is not a list", () => {
    const entry = "include:\n  path: infra/app.yml\n";

    expect(() =>
      workerHealthcheckOf(reader({ "compose.yaml": entry }), "compose.yaml"),
    ).toThrow("include form is not a list of paths");
  });

  it("keeps the reason of the parser when a value cannot be built", () => {
    const thrown = thrownBy(() => readOne("services:\n  worker:\n    <<: 5\n"));

    expect(thrown).toMatchObject({ cause: expect.any(Error) });
    // The reason of the parser is in the text, not only behind `cause`.
    const reason = (thrown as Error).cause as Error;
    expect(reason.message).not.toBe("");
    expect((thrown as Error).message).toContain(reason.message);
  });

  it("refuses an entry file that is not a mapping", () => {
    expect(() =>
      workerHealthcheckOf(reader({ "compose.yaml": "- a\n" }), "compose.yaml"),
    ).toThrow("the document is not a mapping");
  });

  it("takes the included paths from the directory of the entry file", () => {
    const files = reader({
      "deploy/compose.yaml": entryOf("../infra/app.yml"),
      "infra/app.yml": workerFile(GOOD),
    });

    expect(workerHealthcheckOf(files, "deploy/compose.yaml").script).toBe(
      "src/cli/healthcheck.ts",
    );
  });

  it.each([
    ["a shell form", '["CMD-SHELL", "x"]'],
    ["a string", '"node s3cret-value"'],
    [
      "an element that is not a string",
      '["CMD", "node", "--k=s3cret-value", 5]',
    ],
    ["another program", '["CMD", "bun", "--k=s3cret-value", "x.ts"]'],
  ])(
    "names the file and nothing of the environment or the command in a refusal of %s",
    (_case, testYaml) => {
      const app = [
        "services:",
        "  worker:",
        "    environment:",
        "      SECRET: s3cret-value",
        "    healthcheck:",
        `      test: ${testYaml}`,
        "",
      ].join("\n");

      const thrown = thrownBy(() => readOne(app));

      expect(chainText(thrown)).toContain("infra/app.yml");
      // The whole chain of `cause`, which a runner prints, not the message only.
      expect(chainText(thrown)).not.toContain("s3cret-value");
    },
  );
});
