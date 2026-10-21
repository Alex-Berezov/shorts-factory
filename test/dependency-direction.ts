import { posix } from "node:path";
import { DYNAMIC_SPECIFIER, importSpecifiers } from "./imports.js";
import {
  type Manifest,
  readManifest,
  readRepoFile,
  repoFilesUnder,
  repoWorkspaceDirs,
} from "./repo-files.js";

/**
 * The direction of dependencies between the packages of the workspace
 * (docs/10_SYSTEM_DESIGN.md §6), checked on the manifests and on the imports
 * of every file of every package. The table below is the lock; the rules
 * S07, S11, S15 and S16 of `.claude/hooks/rules.sf.json` give a quick signal
 * on the lines being written and say the same for their packages - a new edge
 * is a row here and, for those packages, a line there.
 */

/**
 * The `@sf/*` packages each package may depend on, by package name - the
 * applications too: an application takes the packages its manifest names
 * today and no other, so `apps/web -> @sf/db` is a violation (§6, S11), and a
 * new edge of an application is a row edited on purpose. A package missing
 * from the table is a violation, not a free pass, and so is a row naming a
 * package the workspace does not have.
 */
const ALLOWED_EDGES: Readonly<Record<string, readonly string[]>> = {
  "@sf/core": [],
  "@sf/config": [],
  "@sf/contracts": ["@sf/core"],
  "@sf/api-client": ["@sf/contracts"],
  "@sf/db": ["@sf/core"],
  "@sf/runtime": ["@sf/config", "@sf/core"],
  "@sf/youtube": ["@sf/core", "@sf/config"],
  "@sf/gemini": ["@sf/core", "@sf/config"],
  "@sf/tts": ["@sf/core", "@sf/config"],
  "@sf/web": ["@sf/api-client", "@sf/contracts", "@sf/config"],
  "@sf/api": [
    "@sf/config",
    "@sf/contracts",
    "@sf/core",
    "@sf/db",
    "@sf/runtime",
    "@sf/youtube",
  ],
  "@sf/worker": [
    "@sf/config",
    "@sf/core",
    "@sf/db",
    "@sf/runtime",
    "@sf/youtube",
    "@sf/gemini",
    "@sf/tts",
  ],
};

/**
 * `@sf/db -> @sf/config` exists only where ADR-0002 puts it: the entry points
 * of the CLI that read the configuration (`src/cli/migrate.ts`,
 * `src/cli/seed.ts`, `src/cli/migrate-and-seed.ts` - files, not the whole
 * `src/cli/`), the tests, the test support and the vitest configs of the
 * package (`vitest*.config.ts`, and its `.mts`/`.cts` forms).
 * `drizzle.config.ts` is not among them: ADR-0002 keeps the connection string
 * out of it. The manifest keeps `@sf/config` in `dependencies` - the image of
 * `migrate` installs with `--prod` and runs the CLI - so the edge is a named
 * exception there, and the boundary is held by the imports. No other file of
 * the package - its library part, `drizzle.config.ts` - takes anything from
 * `src/cli/` (`DB_CLI`), so the configuration cannot reach it through a
 * module of the CLI.
 */
const DB_CONFIG_EXCEPTION = {
  from: "@sf/db",
  to: "@sf/config",
  files: [
    /^src\/cli\/(?:migrate|seed|migrate-and-seed)\.ts$/,
    /^test\//,
    /^test-support\//,
    /^vitest[^/]*\.config\.[mc]?ts$/,
  ],
} as const;

/** The CLI of `@sf/db`, which its files that may not read the configuration do not import (`intoDbCli`). */
const DB_CLI = { name: "@sf/db", dir: "src/cli/" } as const;

/**
 * The files of a package that never ship: its tests, its test support and
 * its vitest configs. Every other file - `src/`, `next.config.*`, the scripts
 * an image runs, `drizzle.config.ts` - ships, and takes no test support.
 * A test under `src/` is no file that ships only under the name the preset
 * of ADR-0011 runs, `*.test.ts`: the probe of each image holds its packages
 * to no file of that name at any depth (`noTests` of `scripts/probe-image.mjs`).
 * Any other name - `*.test.tsx`, `*.test.js` - is neither run nor kept out
 * of an image, so it ships.
 */
const NOT_SHIPPED = [
  /^test\//,
  /^test-support\//,
  /(?:^|\/)[^/]+\.test\.ts$/,
  /^vitest[^/]*\.config\.[cm]?[jt]s$/,
];

/**
 * Web takes `@sf/config` in its own code only through the server entry
 * `@sf/config/server` (ADR-0001, the rule S11): the root and every other
 * subpath carry what must not reach the bundle. Outside `src/` - the scripts
 * and configs of the build - the edge of the table is enough.
 */
const WEB_CONFIG = {
  from: "@sf/web",
  to: "@sf/config",
  entry: "@sf/config/server",
  files: /^src\//,
} as const;

/** `@sf/<package>/test-support/...`: test fixtures of a package, never code that ships. */
const TEST_SUPPORT = /^@sf\/[^/]+\/test-support(?:\/|$)/;

/** The dependency fields of a manifest that make an edge. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface SourceFile {
  /** Path from the directory of the package, `/`-separated. */
  path: string;
  text: string;
}

export interface WorkspacePackage {
  /** Path of the package from the root (`apps/api`). */
  dir: string;
  manifest: Manifest;
  files: SourceFile[];
}

/** The files whose imports are read: everything a TypeScript or JavaScript loader would take. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** `@sf/db/test-support/fixture` -> `@sf/db`; null for a specifier outside `@sf/*`. */
function packageOf(specifier: string): string | null {
  const match = /^(@sf\/[^/]+)/.exec(specifier);
  return match?.[1] ?? null;
}

/** Whether `from` may depend on `to`, by the table and nothing else. */
function edgeAllowed(
  from: WorkspacePackage,
  to: string,
  names: ReadonlySet<string>,
): boolean {
  if (to === from.manifest.name) return true;
  if (!names.has(to)) return false;
  return ALLOWED_EDGES[from.manifest.name]?.includes(to) ?? false;
}

/** A package the table does not know, as a violation; null for a known one. */
function unknownPackage(pkg: WorkspacePackage): string | null {
  return Object.hasOwn(ALLOWED_EDGES, pkg.manifest.name)
    ? null
    : `${pkg.manifest.name} (${pkg.dir}) is not in the table of allowed edges`;
}

function namesOf(workspace: readonly WorkspacePackage[]): Set<string> {
  return new Set(workspace.map((pkg) => pkg.manifest.name));
}

/**
 * The rows of the table that name a package the workspace does not have,
 * as the package or as a target: a row left behind by a removed or renamed
 * package would allow an edge nobody checks.
 */
export function tableViolations(
  workspace: readonly WorkspacePackage[],
): string[] {
  const names = namesOf(workspace);
  const violations: string[] = [];
  for (const [from, targets] of Object.entries(ALLOWED_EDGES)) {
    if (!names.has(from)) {
      violations.push(`the table has a row for ${from}, not in the workspace`);
    }
    for (const to of targets) {
      if (!names.has(to)) {
        violations.push(
          `the row of ${from} allows ${to}, not in the workspace`,
        );
      }
    }
  }
  return violations;
}

/**
 * The `@sf/*` names of the dependency fields of every manifest that the
 * table does not allow. `@sf/config` in the manifest of `@sf/db` is the named
 * exception of ADR-0002.
 */
export function manifestViolations(
  workspace: readonly WorkspacePackage[],
): string[] {
  const names = namesOf(workspace);
  const violations: string[] = [];
  for (const pkg of workspace) {
    const unknown = unknownPackage(pkg);
    if (unknown !== null) {
      violations.push(unknown);
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        if (packageOf(name) === null) continue;
        const exception =
          pkg.manifest.name === DB_CONFIG_EXCEPTION.from &&
          name === DB_CONFIG_EXCEPTION.to;
        if (!exception && !edgeAllowed(pkg, name, names)) {
          violations.push(`${pkg.dir}/package.json ${field}: ${name}`);
        }
      }
    }
  }
  return violations;
}

/**
 * The package of the workspace whose directory holds `target` (a path from
 * the root): the deepest one, so a package nested in another owns its own
 * files; null for a file of no package (the root, `vitest.preset.ts`).
 */
function ownerOf(target: string, dirs: readonly string[]): string | null {
  let owner: string | null = null;
  for (const dir of dirs) {
    const inside = target === dir || target.startsWith(`${dir}/`);
    if (inside && (owner === null || dir.length > owner.length)) owner = dir;
  }
  return owner;
}

/**
 * Where a relative `specifier` of `file` in `pkg` leads, as a violation: out
 * of the repository, or into the directory of another package - always, not
 * by the table: a package is taken by its `@sf/*` name, which is what the
 * table and the manifests see, and a relative path into it is an edge neither
 * of them knows (`../../config/src` from `@sf/db`, `../../../packages/db/src`
 * from web). A file of no package - the root presets of ADR-0011 - is not a
 * package and passes. Null for a specifier that is not relative.
 */
function relativeEscape(
  pkg: WorkspacePackage,
  file: SourceFile,
  specifier: string,
  dirs: readonly string[],
): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = posix.normalize(
    posix.join(pkg.dir, posix.dirname(file.path), specifier),
  );
  if (target === ".." || target.startsWith("../")) {
    return `${specifier} (relative path out of the repository)`;
  }
  const owner = ownerOf(target, dirs);
  return owner === null || owner === pkg.dir
    ? null
    : `${specifier} (relative path into ${owner}: a package is taken by its @sf/* name)`;
}

/**
 * The imports of `@sf/*` in the files of every package that the table does
 * not allow; `@sf/config` in `@sf/db` outside the files of ADR-0002; in web's
 * own code, `@sf/config` other than `@sf/config/server`; the test support of
 * any package (`@sf/<package>/test-support/*`, or a relative path into the
 * package's own `test-support/`) from any file that ships (`NOT_SHIPPED`,
 * §6); a module of `src/cli/` of `@sf/db` from a file of it that may not
 * read the configuration (`intoDbCli`); a relative
 * path out of the package into another one or out of the repository; and
 * every import whose target cannot be read.
 */
export function importViolations(
  workspace: readonly WorkspacePackage[],
): string[] {
  const names = namesOf(workspace);
  const dirs = workspace.map((entry) => entry.dir);
  const violations: string[] = [];
  for (const pkg of workspace) {
    const unknown = unknownPackage(pkg);
    if (unknown !== null) {
      violations.push(unknown);
      continue;
    }
    for (const file of pkg.files) {
      const problem = (specifier: string): string | null => {
        if (specifier === DYNAMIC_SPECIFIER) {
          return "import with a computed specifier";
        }
        if (
          !NOT_SHIPPED.some((pattern) => pattern.test(file.path)) &&
          intoTestSupport(file, specifier)
        ) {
          return `${specifier} (test support from a file that ships)`;
        }
        if (intoDbCli(pkg, file, specifier)) {
          return `${specifier} (library code of @sf/db takes nothing from src/cli: ADR-0002)`;
        }
        const outOfPackage = relativeEscape(pkg, file, specifier, dirs);
        if (outOfPackage !== null) return outOfPackage;
        const to = packageOf(specifier);
        if (to === null) return null;
        const name = pkg.manifest.name;
        if (
          name === DB_CONFIG_EXCEPTION.from &&
          to === DB_CONFIG_EXCEPTION.to
        ) {
          return DB_CONFIG_EXCEPTION.files.some((allowed) =>
            allowed.test(file.path),
          )
            ? null
            : `${specifier} (ADR-0002: only the CLI, tests and vitest configs)`;
        }
        if (
          name === WEB_CONFIG.from &&
          to === WEB_CONFIG.to &&
          WEB_CONFIG.files.test(file.path) &&
          specifier !== WEB_CONFIG.entry
        ) {
          return `${specifier} (web code takes only ${WEB_CONFIG.entry})`;
        }
        return edgeAllowed(pkg, to, names) ? null : specifier;
      };
      for (const specifier of importSpecifiers(file.path, file.text)) {
        const found = problem(specifier);
        if (found !== null)
          violations.push(`${pkg.dir}/${file.path}: ${found}`);
      }
    }
  }
  return violations;
}

/**
 * Whether `specifier` in a file of `@sf/db` that may not read the
 * configuration reaches `src/cli/` by a relative path: every file outside
 * `src/cli/` and outside the files of `DB_CONFIG_EXCEPTION` - the library
 * modules of `src/`, and `drizzle.config.ts` and whatever else ships at the
 * top of the package. The tests, the test support and the vitest configs may
 * take the CLI, as they may take `@sf/config`.
 */
function intoDbCli(
  pkg: WorkspacePackage,
  file: SourceFile,
  specifier: string,
): boolean {
  if (pkg.manifest.name !== DB_CLI.name || !specifier.startsWith(".")) {
    return false;
  }
  if (
    file.path.startsWith(DB_CLI.dir) ||
    DB_CONFIG_EXCEPTION.files.some((allowed) => allowed.test(file.path))
  ) {
    return false;
  }
  const resolved = posix.normalize(
    posix.join(posix.dirname(file.path), specifier),
  );
  return `${resolved}/`.startsWith(DB_CLI.dir);
}

/** Whether `specifier` in `file` reaches test support: of any package, or the package's own by a relative path. */
function intoTestSupport(file: SourceFile, specifier: string): boolean {
  if (TEST_SUPPORT.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(
    posix.join(posix.dirname(file.path), specifier),
  );
  return resolved === "test-support" || resolved.startsWith("test-support/");
}

/**
 * The packages of the workspace as they are on disk: the manifest of every
 * directory of `repoWorkspaceDirs()` and its source files among those the
 * hash covers, from the one listing of `test/repo-files.ts`.
 */
export function readWorkspace(): WorkspacePackage[] {
  const dirs = repoWorkspaceDirs();
  const files = ["apps", "packages"].flatMap((top) => repoFilesUnder(top));
  const owned = sourceFilesByPackage(files, dirs);
  return dirs.map((dir) => {
    const prefix = `${dir}/`;
    return {
      dir,
      manifest: readManifest(dir),
      files: (owned.get(dir) ?? []).map((path) => ({
        path: path.slice(prefix.length),
        text: readRepoFile(path),
      })),
    };
  });
}

/**
 * The source files of `files` (paths from the root) by the package that
 * owns each - the deepest of `dirs` that contains it (`ownerOf`), so a
 * package nested in another keeps its files to itself. One pass over the
 * files; a file of no package is left out.
 */
export function sourceFilesByPackage(
  files: readonly string[],
  dirs: readonly string[],
): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  for (const path of files) {
    if (!SOURCE_FILE.test(path)) continue;
    const owner = ownerOf(path, dirs);
    if (owner === null) continue;
    const list = owned.get(owner);
    if (list === undefined) owned.set(owner, [path]);
    else list.push(path);
  }
  return owned;
}
