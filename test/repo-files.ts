import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { trackedFiles } from "../scripts/lib/files.mjs";
import { workspaceDirs } from "../scripts/lib/manifest.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { readYaml } from "../scripts/lib/yaml-doc.mjs";

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
 * A YAML text as plain values, by the one fail-closed reading of the root
 * project (`readYaml` of `scripts/lib/yaml-doc.mjs`); anything the parser did
 * not take cleanly throws with its reason, named after `name`. `merge`
 * expands the `<<` key, as Compose does.
 */
export function parseRepoYaml(
  text: string,
  name: string,
  { merge = false }: { merge?: boolean } = {},
): unknown {
  const reading = readYaml(text, { merge });
  switch (reading.kind) {
    case "value":
      return reading.value;
    case "empty":
      throw new Error(`${name} is not read cleanly: no YAML document`);
    case "documents":
      throw new Error(
        `${name} is not read cleanly: ${reading.count} YAML documents`,
      );
    case "notes":
      throw new Error(
        `${name} is not read cleanly: ${reading.notes
          .map((note) => `${note.code}: ${note.message}`)
          .join("; ")}`,
      );
    case "aliases":
      throw new Error(`${name} is not read cleanly: aliases past the limit`);
    case "unbuilt":
      throw new Error(`${name} is not read cleanly: ${reading.message}`);
  }
}

/** A YAML file of the repository, read by `parseRepoYaml`; its shape is the caller's to check. */
export function readRepoYaml(
  path: string,
  options: { merge?: boolean } = {},
): unknown {
  return parseRepoYaml(readRepoFile(path), path, options);
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
  cache: z.boolean().optional(),
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

/** What `trackedFiles` gives, checked: paths from the root, `/` between parts. */
const ListingSchema = z.array(z.string().min(1));

/** The files of the repository the hash covers, from one listing. */
export interface RepoListing {
  /**
   * The files under `dir` (`apps/api`; `.` for the whole tree), as
   * `/`-separated paths from the root: `apps/api` does not take in
   * `apps/api2`.
   */
  under(dir: string): string[];
  /** Whether `path` (from the root, `/`-separated) is a file of the listing. */
  exists(path: string): boolean;
}

/**
 * A listing that asks `list` for the files once, on the first question, and
 * answers every later one from that answer. A `list` that throws (git cannot
 * run, the tree is no repository) throws to the caller of that question - a
 * red case with its reason, not a failure to collect the test file - and is
 * asked again next time.
 */
export function repoListing(list: () => unknown): RepoListing {
  let files: readonly string[] | undefined;
  let known: ReadonlySet<string> | undefined;
  const all = (): readonly string[] => {
    files ??= ListingSchema.parse(list());
    return files;
  };
  return {
    under(dir) {
      if (dir === ".") return [...all()];
      const prefix = `${dir.replace(/\/+$/, "")}/`;
      return all().filter((path) => path.startsWith(prefix));
    },
    exists(path) {
      known ??= new Set(all());
      return known.has(path);
    },
  };
}

/**
 * The listing of this repository: one `git ls-files` (`trackedFiles` of
 * `scripts/lib/files.mjs`, the one the gates list with) per test file that
 * asks, none for one that does not.
 */
const repository = repoListing(() => trackedFiles(repoRoot));

/**
 * The files under `dir` that turbo hashes - tracked by git, or untracked and
 * not ignored - as `/`-separated paths from the root. Ignored files
 * (`coverage/`, build output, `node_modules`) are not among them: what a
 * test learns from them is not in any hash.
 */
export function repoFilesUnder(dir: string): string[] {
  return repository.under(dir);
}

/**
 * Whether `path` (from the root, `/`-separated) is a file the hash covers -
 * the question a test of the root project asks instead of `existsSync`,
 * which also answers for an ignored file.
 */
export function repoFileExists(path: string): boolean {
  return repository.exists(path);
}

/**
 * The package directories of the workspace (`workspaceDirs` of
 * `scripts/lib/manifest.mjs`), from the listing above rather than a second
 * `git ls-files`.
 */
export function repoWorkspaceDirs(): string[] {
  return workspaceDirs(repoRoot, repository.under("."));
}
