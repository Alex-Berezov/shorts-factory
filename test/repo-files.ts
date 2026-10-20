import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { repoRoot } from "../scripts/lib/paths.mjs";

/**
 * Files of the repository for the tests of the root project, by their path
 * from the root (`/`-separated, as the repository writes them). Every file
 * read here must be one the hash covers - tracked by git, or untracked and
 * not ignored, the set `repoFilesUnder` lists: `//#test:repo` hashes those
 * (`$TURBO_DEFAULT$` of a root task), and an ignored one (`coverage/`, build
 * output) would change the result without changing the hash. Files are
 * listed through `repoFilesUnder`, not `readdirSync`, for the same reason.
 */

/** Text of a file of the repository, line ends as on disk. */
export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** A JSON file of the repository, parsed; its shape is the caller's to check. */
export function readRepoJson(path: string): unknown {
  return JSON.parse(readRepoFile(path));
}

/**
 * The fields of a `package.json` the root tests read: all four dependency
 * fields, since each of them makes an edge between packages
 * (`test/dependency-direction.ts`).
 */
export const ManifestSchema = z.object({
  name: z.string(),
  scripts: z.record(z.string()).optional(),
  dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(),
  optionalDependencies: z.record(z.string()).optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** The manifest of the package at `dir` (`apps/api`; `.` for the root). */
export function readManifest(dir: string): Manifest {
  return ManifestSchema.parse(readRepoJson(`${dir}/package.json`));
}

/** A task of a `turbo.json`, by the fields the root tests read. */
const TurboTaskSchema = z.object({
  dependsOn: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  passThroughEnv: z.array(z.string()).optional(),
});

/**
 * A `turbo.json` - the root one or a package's. Keys the tests do not name
 * are kept (`passthrough`): a rule may look for one that must not be there
 * (`cacheDir`, `remoteCache`).
 */
export const TurboSchema = z
  .object({
    globalDependencies: z.array(z.string()).optional(),
    extends: z.array(z.string()).optional(),
    tasks: z.record(TurboTaskSchema),
  })
  .passthrough();
export type Turbo = z.infer<typeof TurboSchema>;

/** The `turbo.json` of the package at `dir` (`.` for the root). */
export function readTurbo(dir: string): Turbo {
  return TurboSchema.parse(readRepoJson(`${dir}/turbo.json`));
}

/**
 * The files under `dir` that turbo hashes - tracked by git, or untracked and
 * not ignored - as `/`-separated paths from the root. Ignored files
 * (`coverage/`, build output, `node_modules`) are not among them: what a
 * test learns from them is not in any hash.
 */
export function repoFilesUnder(dir: string): string[] {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files -- ${dir} failed: ${listed.stderr}`);
  }
  return listed.stdout
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(repoRoot, path)));
}
