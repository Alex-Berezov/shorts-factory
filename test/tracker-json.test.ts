import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo-files.js";
import { STATUSES, TrackerSchema, readTracker, taskEntry } from "./tracker.js";

/**
 * docs/tasks/tasks.json is held to `TrackerSchema` (`test/tracker.ts`), and
 * the schema to the CLI that writes the file: its statuses are the keys of
 * `ICON` in scripts/tasks.mjs.
 */

/** The statuses of the CLI: the keys of `ICON` in scripts/tasks.mjs. */
function cliStatuses(): string[] {
  const source = readRepoFile("scripts/tasks.mjs");
  const body = /const ICON = \{([^}]*)\}/.exec(source)?.[1];
  // A reading that finds nothing would compare nothing.
  if (body === undefined)
    throw new Error("no `const ICON = {...}` in scripts/tasks.mjs");
  return [...body.matchAll(/(\w+):/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/** The task of `taskEntry` with `over` laid on it, a value out of the schema too. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...taskEntry(), ...over };
}

/** What the schema says of `raw`: the path of each issue, and its message. */
function issues(raw: unknown): string[] {
  const parsed = TrackerSchema.safeParse(raw);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
}

describe("docs/tasks/tasks.json", () => {
  it("passes the schema, and is not empty", () => {
    expect(readTracker().length).toBeGreaterThan(0);
  });

  it("has the statuses the CLI has", () => {
    expect(cliStatuses().sort()).toEqual([...STATUSES].sort());
  });

  it("accepts a well-formed tracker", () => {
    expect(
      issues([
        entry({
          status: "done",
          done_at: "2026-11-02",
          started_at: "2026-11-01",
        }),
        entry({ id: "E0-02", deps: ["E0-01"], estimate_days: null }),
        entry({ id: "E0-12AK", deps: ["ADHOC-20261102-1"] }),
        entry({
          id: "ADHOC-20261102-1",
          epic: "ADHOC",
          status: "blocked",
          blocked_reason: "wait",
          added_at: "2026-11-02",
          note: "",
        }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ["a misspelt field", [entry({ stauts: "todo" })], /^0: .*stauts/],
    ["an unknown status", [entry({ status: "finished" })], /^0\.status: /],
    [
      "an id out of the grammar",
      [entry({ id: "e0-01" })],
      /^0\.id: id "e0-01" is neither/,
    ],
    [
      "an ADHOC id with no day",
      [entry({ id: "ADHOC-1", epic: "ADHOC" })],
      /^0\.id: id "ADHOC-1" is neither/,
    ],
    [
      "an epic out of the grammar",
      [entry({ epic: "E" })],
      /^0\.epic: epic "E" is neither/,
    ],
    [
      "the epic ADHOC on a task of an epic",
      [entry({ epic: "ADHOC" })],
      /^0\.epic: epic ADHOC does not go with the id E0-01/,
    ],
    [
      "an epic other than the one of the id",
      [entry({ epic: "E1" })],
      /^0\.epic: epic E1 does not go with the id E0-01/,
    ],
    [
      "an ADHOC task of an epic",
      [entry({ id: "ADHOC-20261102-1", epic: "E0" })],
      /^0\.epic: epic E0 does not go with the id ADHOC-20261102-1/,
    ],
    ["an empty title", [entry({ title: " " })], /^0\.title: title is empty/],
    [
      "a title with a line break",
      [entry({ title: "First\nline" })],
      /^0\.title: title is empty or has a line break$/,
    ],
    [
      "an empty estimate",
      [entry({ estimate: " " })],
      /^0\.estimate: estimate is empty or has a line break$/,
    ],
    [
      "an estimate with a line break",
      [entry({ estimate: "1\nд" })],
      /^0\.estimate: estimate is empty or has a line break$/,
    ],
    ["an empty doc", [entry({ doc: "" })], /^0\.doc: /],
    [
      "estimate_days as text",
      [entry({ estimate_days: "1" })],
      /^0\.estimate_days: /,
    ],
    [
      "a started_at that is not a day",
      [entry({ started_at: "2026-11-2" })],
      /^0\.started_at: /,
    ],
    [
      "a done_at that is not a day",
      [entry({ status: "done", done_at: "02.11.2026" })],
      /^0\.done_at: /,
    ],
    [
      "an added_at that is not a day",
      [entry({ added_at: "today" })],
      /^0\.added_at: /,
    ],
    ["a duplicate id", [entry(), entry()], /^1\.id: duplicate id E0-01$/],
    [
      "a dangling dep",
      [entry({ deps: ["E9-99"] })],
      /^0\.deps: E0-01 depends on E9-99, which is not in the tracker$/,
    ],
    [
      "a blocked task with no reason",
      [entry({ status: "blocked" })],
      /^0\.blocked_reason: E0-01 is blocked with no blocked_reason$/,
    ],
    [
      "a done task with no done_at",
      [entry({ status: "done" })],
      /^0\.done_at: E0-01 is done with no done_at$/,
    ],
  ])("refuses %s, by that check alone", (_, raw, why) => {
    expect(issues(raw)).toEqual([expect.stringMatching(why)]);
  });
});
