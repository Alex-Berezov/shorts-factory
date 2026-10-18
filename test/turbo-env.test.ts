import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * turbo runs its tasks in strict env mode: a variable `turbo.json` does not
 * declare does not reach the task. The build labels a release passes in the
 * shell would then stop at `pnpm dev`, and `/system/status` would report
 * `null` for a build that knew its version.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `BUILD_LABEL_NAMES` of `packages/config/src/schema.ts`, as a literal: the
 * root project depends on no package, and the list is two names long.
 */
const BUILD_LABEL_NAMES = ["APP_VERSION", "GIT_COMMIT"];

interface TurboTask {
  env?: string[];
  passThroughEnv?: string[];
  inputs?: string[];
}

function turboTask(name: string): TurboTask {
  const turbo: { tasks: Record<string, TurboTask> } = JSON.parse(
    readFileSync(join(ROOT, "turbo.json"), "utf8"),
  );
  const task = turbo.tasks[name];
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
    // from drifting apart.
    const schema = readFileSync(
      join(ROOT, "packages/config/src/schema.ts"),
      "utf8",
    );
    const declared = /BUILD_LABEL_NAMES = \[([^\]]*)\]/.exec(schema)?.[1];
    const names = [...(declared ?? "").matchAll(/"([A-Z_]+)"/g)].map(
      (match) => match[1],
    );

    expect(names).toEqual(BUILD_LABEL_NAMES);
  });
});

describe("turbo.json, test:repo task", () => {
  it("hashes the schema the root project reads", () => {
    // The case above reads `packages/config/src/schema.ts`, outside the root
    // project: a hash without it would replay a green run after the schema
    // changed. The default inputs of a root task cover the file today; the
    // explicit entry keeps a narrower `inputs` from dropping it silently.
    expect(turboTask("//#test:repo").inputs).toEqual(
      expect.arrayContaining([
        "$TURBO_DEFAULT$",
        "$TURBO_ROOT$/packages/config/src/schema.ts",
      ]),
    );
  });
});
