import { describe, expect, it } from "vitest";
import { readRepoFile, readTurbo } from "./repo-files.js";

/**
 * turbo runs its tasks in strict env mode: a variable `turbo.json` does not
 * declare does not reach the task. The build labels a release passes in the
 * shell would then stop at `pnpm dev`, and `/system/status` would report
 * `null` for a build that knew its version.
 *
 * `BUILD_LABEL_NAMES` of `packages/config/src/schema.ts`, as a literal: the
 * root project depends on no package, and the list is two names long.
 */
const BUILD_LABEL_NAMES = ["APP_VERSION", "GIT_COMMIT"];

function turboTask(name: string) {
  const task = readTurbo(".").tasks[name];
  if (task === undefined) {
    throw new Error(`turbo.json declares no "${name}" task`);
  }
  return task;
}

describe("turbo.json, dev task", () => {
  it("lets the build labels through to the services", () => {
    expect(turboTask("dev").passThroughEnv).toEqual(
      expect.arrayContaining(BUILD_LABEL_NAMES),
    );
  });

  it("does not make them part of the hash", () => {
    // `env` would: the labels change with every commit, and `dev` is not
    // cached anyway - what it needs is the value, not a new hash.
    expect(turboTask("dev").env ?? []).not.toEqual(
      expect.arrayContaining(BUILD_LABEL_NAMES),
    );
  });

  it("lists the same names as the config schema", () => {
    // The literal above against the schema it copies, read as text: the
    // root project imports no package, so this is what keeps the two lists
    // from drifting apart. The file is in the hash of `//#test:repo` as every
    // tracked file is (rule (d) of turbo-inputs.test.ts).
    const schema = readRepoFile("packages/config/src/schema.ts");
    const declared = /BUILD_LABEL_NAMES = \[([^\]]*)\]/.exec(schema)?.[1];
    const names = [...(declared ?? "").matchAll(/"([A-Z_]+)"/g)].map(
      (match) => match[1],
    );

    expect(names).toEqual(BUILD_LABEL_NAMES);
  });
});
