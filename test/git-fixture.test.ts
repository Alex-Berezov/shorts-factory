import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { gitScratch, isolatedGitEnv } from "./git-fixture.js";

/**
 * The trees of the tests that run git (`test/git-fixture.ts`): git on a tree
 * of the scratch directory sees that tree and nothing else, whatever the
 * variables of the run and wherever the system temp is.
 */
const scratch = gitScratch("sf-git-fixture-");

/** What `git ls-files` says in `cwd` under `env`. */
function listing(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync("git", ["ls-files"], { cwd, encoding: "utf8", env });
}

describe("isolatedGitEnv", () => {
  it.each([
    "GIT_DIR",
    "git_dir",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  ])("drops %s and keeps the rest", (key) => {
    const env = isolatedGitEnv({ [key]: "x", PATH: "p" }, "/c");

    expect(env).toEqual({ PATH: "p", GIT_CEILING_DIRECTORIES: "/c" });
  });

  it("puts its own ceiling in place of the one of the run", () => {
    expect(
      isolatedGitEnv({ GIT_CEILING_DIRECTORIES: "/elsewhere" }, "/c"),
    ).toEqual({ GIT_CEILING_DIRECTORIES: "/c" });
  });

  it("keeps git off the repository GIT_DIR of the run names", () => {
    const root = scratch.files("redirected", { "a.ts": "" });
    const run = { ...process.env, GIT_DIR: join(repoRoot, ".git") };

    const result = listing(root, isolatedGitEnv(run, scratch.dir));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });

  it("keeps git from climbing out of the ceiling into a work tree around it", () => {
    const outer = scratch.tree("outer", { "a.ts": "" });
    const inner = join(outer, "inner");
    mkdirSync(inner);

    const result = listing(inner, isolatedGitEnv(process.env, outer));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });
});

describe("gitScratch", () => {
  it("lists a tree of its own, untracked files included", () => {
    const root = scratch.tree("own", { "a.ts": "", "b/c.ts": "" });

    const result = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", env: scratch.env },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").sort()).toEqual(["a.ts", "b/c.ts"]);
  });

  it("isolates the variables of the process for the git the tests run in it", () => {
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(dirname(scratch.dir));
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  });

  it("puts the ceiling of its children at the parent of its directory", () => {
    expect(scratch.env.GIT_CEILING_DIRECTORIES).toBe(dirname(scratch.dir));
  });
});

describe("gitScratch in a run whose variables redirect git", () => {
  const RUN = {
    GIT_DIR: "/elsewhere/.git",
    git_index_file: "/elsewhere/index",
  };
  const vars: NodeJS.ProcessEnv = { ...RUN, PATH: "p" };
  // Registered before the hooks of gitScratch, so it runs after them.
  afterAll(() => {
    expect(vars).toEqual({ ...RUN, PATH: "p" });
  });
  const own = gitScratch("sf-git-fixture-run-", { vars });

  it("drops them, and only them, while its tests run", () => {
    expect(vars).toEqual({
      PATH: "p",
      GIT_CEILING_DIRECTORIES: dirname(own.dir),
    });
  });
});

describe("gitScratch made inside a work tree", () => {
  const around = scratch.tree("around", { "a.ts": "" });
  const own = gitScratch("sf-git-fixture-inner-", { under: around });

  it("keeps git in its own directory off the work tree around it", () => {
    const result = listing(own.dir, own.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });

  it("keeps git in a tree of it off the work tree around it", () => {
    const root = own.files("plain", { "b.ts": "" });

    const result = listing(root, own.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });
});

describe("the run after a gitScratch nested in a describe", () => {
  it("holds the ceiling of the scratch of the file again", () => {
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(dirname(scratch.dir));
  });
});
