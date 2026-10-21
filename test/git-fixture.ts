import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

/**
 * Trees for the tests of the root project that run git on a directory of
 * their own (`trackedFiles` of `scripts/lib/files.mjs`, `workspaceDirs`, the
 * gate no-search-list): one scratch directory per file of tests, removed
 * after it, and git cut off from whatever repository the run of the tests is
 * in. The variables that point git at another repository or index (a hook of
 * git sets `GIT_DIR` and `GIT_INDEX_FILE` for what it runs) are dropped, and
 * the parent of the scratch directory is a ceiling
 * (`GIT_CEILING_DIRECTORIES`): git looks for a repository in the directory
 * it runs in and climbs, but never into a ceiling - so a ceiling must be the
 * parent of the topmost directory git may look at, the scratch directory
 * itself included. A tree that is no work tree, or the scratch directory, is
 * then "not a git repository" wherever the system temp is, even inside a
 * work tree. The git of the test itself (`trackedFiles` called in the
 * process) runs under the same variables as the children it starts, for the
 * whole file of tests; the variables are restored after it by name - only
 * the ones changed, so nothing else of the process is touched.
 *
 * Not dropped: the variables of the configuration of git
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`), which
 * change how git lists, not which repository it lists.
 */

/** The variables that make git look at another repository, index or tree than the one at its cwd. */
const REDIRECTING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/** Whether the variable `key` is one of `REDIRECTING`, in any case (Windows). */
function isRedirecting(key: string): boolean {
  return REDIRECTING.includes(key.toUpperCase());
}

/**
 * `base` without the variables that redirect git, and with `ceiling` as the
 * one directory git does not climb into while it looks for a repository: the
 * parent of the topmost directory git may look at.
 */
export function isolatedGitEnv(
  base: NodeJS.ProcessEnv,
  ceiling: string,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !isRedirecting(key)),
  );
  return { ...env, GIT_CEILING_DIRECTORIES: ceiling };
}

/** A scratch directory of one file of tests, and the trees made under it. */
export interface GitScratch {
  /** The scratch directory, its real path. */
  readonly dir: string;
  /** The variables for a child that runs git on a tree of the scratch directory. */
  readonly env: NodeJS.ProcessEnv;
  /** A directory `name` holding the given files (path -> contents), no git. */
  files(name: string, contents: Record<string, string>): string;
  /** A git work tree `name` holding the given files, none added. */
  tree(name: string, contents: Record<string, string>): string;
  /** Runs git with `args` in `cwd`, which must succeed. */
  git(cwd: string, args: string[]): void;
}

/** Where `gitScratch` makes its directory and whose variables it isolates. */
export interface ScratchOptions {
  /** The variables isolated while the tests run; `process.env` by default. */
  readonly vars?: NodeJS.ProcessEnv;
  /** The directory the scratch directory is made in; the system temp by default. */
  readonly under?: string;
}

/**
 * The scratch directory of a file of tests, named after `prefix`. Called at
 * the top of the file (or of a `describe`): it removes the directory after
 * it, and keeps the variables (`process.env` unless `vars` names others)
 * isolated (`isolatedGitEnv`) while its tests run - the variables that
 * redirect git dropped, the parent of the directory the ceiling - and
 * restores the ones it changed, by name, after them.
 */
export function gitScratch(
  prefix: string,
  { vars = process.env, under = tmpdir() }: ScratchOptions = {},
): GitScratch {
  const dir = realpathSync.native(mkdtempSync(join(under, prefix)));
  const ceiling = dirname(dir);
  const env = isolatedGitEnv(vars, ceiling);
  /** The variables changed for the tests, by name, with the values to restore. */
  let saved: [string, string | undefined][] = [];
  beforeAll(() => {
    const changed = Object.keys(vars).filter(isRedirecting);
    saved = changed.map((key) => [key, vars[key]]);
    for (const key of changed) delete vars[key];
    vars.GIT_CEILING_DIRECTORIES = ceiling;
  });
  afterAll(() => {
    // Deleted, not set to undefined: process.env would keep "undefined".
    Reflect.deleteProperty(vars, "GIT_CEILING_DIRECTORIES");
    for (const [key, value] of saved) {
      if (value !== undefined) vars[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, args: string[]): void => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8", env });
    expect(run.status, `git ${args.join(" ")}: ${run.stderr}`).toBe(0);
  };
  const files = (name: string, contents: Record<string, string>): string => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    for (const [path, text] of Object.entries(contents)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  return {
    dir,
    env,
    files,
    tree: (name, contents) => {
      const root = files(name, contents);
      git(root, ["init", "-q"]);
      return root;
    },
    git,
  };
}
