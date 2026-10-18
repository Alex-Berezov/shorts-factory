import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { readRepoFile } from "./repo-files.js";

/**
 * The tracker CLI (`scripts/tasks.mjs`) names its commands when it is given
 * one it does not know. The list it prints is held to the `case` labels of
 * its own `switch`, read from the source, so a command added to one and not
 * the other is red here.
 */
const SCRIPT = join(repoRoot, "scripts", "tasks.mjs");

/** How long the CLI may take before the run is killed and the case is red. */
const RUN_TIMEOUT_MS = 20_000;

/** The `case "..."` labels of the script's command switch. */
function caseLabels(): string[] {
  const source = readRepoFile("scripts/tasks.mjs");
  return [...source.matchAll(/^\s*case "([a-z-]+)":/gm)]
    .map((match) => match[1])
    .filter((label): label is string => label !== undefined);
}

describe("tasks.mjs, an unknown command", () => {
  let result: SpawnSyncReturns<string>;
  beforeAll(() => {
    result = spawnSync(process.execPath, [SCRIPT, "no-such-command"], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
  }, RUN_TIMEOUT_MS + 5_000);

  it("fails", () => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command no-such-command");
  });

  it("names every command the script has", () => {
    const labels = caseLabels();
    const valid = /Valid: ([^;]*);/.exec(result.stderr)?.[1]?.split(", ");

    expect(labels.length).toBeGreaterThanOrEqual(10);
    expect(labels).toContain("add");
    expect([...(valid ?? [])].sort()).toEqual([...labels].sort());
  });
});
