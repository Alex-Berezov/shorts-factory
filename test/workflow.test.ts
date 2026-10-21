import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluateOne,
  pullRequest,
  push,
  stepsIn,
} from "./workflow.js";

/**
 * The reading of the workflow of CI (`test/workflow.ts`): each shape it
 * refuses, and the expressions it evaluates the way Actions does.
 */
describe("reading ci.yml", () => {
  const job = "jobs:\n  ci:\n    runs-on: x\n    steps:\n      - run: a\n";

  it("reads a workflow of the shape the rules know", () => {
    expect(
      stepsIn(`on:\n  push:\n${job}`, "ci").map((step) => step.run),
    ).toEqual(["a"]);
  });

  it.each([
    ["a tab in the indentation", `on:\n\tpush:\n${job}`, "TAB_AS_INDENT"],
    [
      "a second document",
      `on:\n  push:\n${job}---\nx: 1\n`,
      "2 YAML documents",
    ],
    ["an empty text", "", "no YAML document"],
    [
      "an alias before its anchor",
      `on: *events\n${job}`,
      "is not read cleanly",
    ],
    [
      "a key twice",
      `on:\n  push:\non:\n  pull_request:\n${job}`,
      "DUPLICATE_KEY",
    ],
    [
      "a tag the parser does not know",
      `on: !event\n  push:\n${job}`,
      "TAG_RESOLVE_FAILED",
    ],
    ["on as a list", `on: [push]\n${job}`, "on: Expected object"],
    [
      "jobs as a list",
      "on:\n  push:\njobs:\n  - ci\n",
      "jobs: Expected object",
    ],
    [
      "steps as a map",
      "on:\n  push:\njobs:\n  ci:\n    steps:\n      run: a\n",
      "jobs.ci.steps: Expected array",
    ],
    [
      "a step that is not a map",
      "on:\n  push:\njobs:\n  ci:\n    steps:\n      - pnpm test\n",
      "jobs.ci.steps.0: Expected object",
    ],
    ["no jobs", "on:\n  push:\n", "jobs: Required"],
  ])("refuses %s", (_what, text, problem) => {
    expect(() => stepsIn(text, "ci")).toThrow(problem);
  });

  it("refuses a job that is not there", () => {
    expect(() => stepsIn(`on:\n  push:\n${job}`, "other")).toThrow(
      "ci.yml has no job other",
    );
  });
});

describe("the expressions of ci.yml", () => {
  it.each([
    ["github.event_name == 'pull_request'", pullRequest(7, "a"), true],
    ["github.event_name != 'PULL_REQUEST'", pullRequest(7, "a"), false],
    ["github.event.pull_request.number || github.sha", push("a1"), "a1"],
    ["github.event.pull_request.number || github.sha", pullRequest(7, "a1"), 7],
    ["(true && 'x') || 'y'", push("a"), "x"],
    ["false && 'x'", push("a"), false],
    ["null == 0", push("a"), true],
    ["'it''s'", push("a"), "it's"],
  ] as const)("evaluates %s", (expression, event, value) => {
    expect(evaluateOne(expression, event)).toBe(value);
  });

  it.each([
    ["!github.sha", "unknown token"],
    ["github.sha + 1", "unknown token"],
    ["github.actor", "unknown context github.actor"],
    ["(true", "ends early"],
    ["true false", "unexpected false"],
    ["fromJSON('1')", "unknown context fromJSON"],
  ])("refuses %s", (expression, problem) => {
    expect(() => evaluateOne(expression, push("a"))).toThrow(problem);
  });

  it("formats several expressions in one value as Actions does", () => {
    expect(
      evaluate(
        "ci-${{ github.event_name }}-${{ github.event.pull_request.number }}",
        push("a"),
      ),
    ).toBe("ci-push-");
  });

  it("takes two expressions side by side for two, not for one", () => {
    expect(
      evaluate("${{ github.event_name }}-${{ github.sha }}", push("a1")),
    ).toBe("push-a1");
  });

  it("keeps the type of the result of a lone expression", () => {
    expect(
      evaluate("${{ github.event.pull_request.number }}", pullRequest(7, "a")),
    ).toBe(7);
  });
});
