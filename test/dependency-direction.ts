import { createRequire } from "node:module";
import { posix } from "node:path";
import { z } from "zod";
import { DYNAMIC_SPECIFIER, importSpecifiers } from "./imports.js";
import {
  type Manifest,
  RULES_FILE,
  readManifest,
  readRepoFile,
  readRules,
  repoFilesUnder,
  repoWorkspaceDirs,
} from "./repo-files.js";

/**
 * The direction of dependencies between the packages of the workspace
 * (docs/10_SYSTEM_DESIGN.md §6), checked on the manifests and on the imports
 * of every file of every package. The table below is the lock; the rules
 * S07, S11, S15 and S16 of `.claude/hooks/rules.sf.json` give a quick signal
 * on the lines being written and say the same for their packages. A new edge
 * is a row of the table; the rules are held to it by
 * `directionRuleViolations` below (the `describe` "the rules of standards
 * against the table"), and a rule that disagrees with the table is red.
 */

/** The table of allowed edges by package name: the `@sf/*` packages each may depend on. */
export type EdgeTable = Readonly<Record<string, readonly string[]>>;

/**
 * The `@sf/*` packages each package may depend on, by package name - the
 * applications too: an application takes the packages its manifest names
 * today and no other, so `apps/web -> @sf/db` is a violation (§6, S11), and a
 * new edge of an application is a row edited on purpose. A package missing
 * from the table is a violation, not a free pass, and so is a row naming a
 * package the workspace does not have.
 */
const ALLOWED_EDGES: EdgeTable = {
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
 * its vitest configs. Every other file - `src/`, `next.config.*` (`next
 * start` loads it), the scripts an image runs, `drizzle.config.ts` - ships,
 * and takes no test support; only `devOnlyImports` reads `drizzle.config.ts`
 * as the config of a dev tool (`DEV_TOOL_CONFIGS`, E0-12V).
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
 * The configs of a dev tool, which only that tool reads (`drizzle-kit`
 * reads `drizzle.config.ts`): they ship and take no test support, but may
 * import a package of `devDependencies`. Only `devOnlyImports` passes them
 * (E0-12V).
 */
const DEV_TOOL_CONFIGS = [/^drizzle\.config\.[cm]?[jt]s$/];

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

/**
 * A line rule of `standards` in `RULES_FILE`, by the fields `standards.js`
 * reads to apply it to a file and to match a line (`prepare`, `hits`,
 * `checkFile`). Only the rules of `DIRECTION_RULES` are read by it: the hook
 * takes a rule without an id, and the other rules are not this check's.
 */
const StandardRuleSchema = z.object({
  id: z.string(),
  kind: z.string().optional(),
  files: z.array(z.string()).optional(),
  pattern: z.string(),
  skipIf: z.string().optional(),
  flags: z.string().optional(),
});
export type StandardRule = z.infer<typeof StandardRuleSchema>;

/**
 * The rules of standards that say the direction of one package each, with
 * the package they speak for and the source files of that package the rule
 * has to see (`zone`, a path from the directory of the package): what that
 * package may import is a row of the table, and the rule has to refuse
 * exactly the rest. Web is held in `src/` only, as in `WEB_CONFIG`: its
 * build scripts and configs take the edge of the table.
 */
const DIRECTION_RULES = [
  { id: "S07", owner: "@sf/core", zone: /^/ },
  { id: "S11", owner: "@sf/web", zone: WEB_CONFIG.files },
  { id: "S15", owner: "@sf/contracts", zone: /^/ },
  { id: "S16", owner: "@sf/api-client", zone: /^/ },
] as const;

const RuleIdSchema = z.object({ id: z.string() }).passthrough();

/**
 * The rules of `DIRECTION_RULES` among `standards` (those of `RULES_FILE` by
 * default), checked by shape; a rule of another id, or one without an id,
 * is passed over unread.
 */
export function readStandardRules(
  standards: readonly unknown[] = readRules().standards,
): StandardRule[] {
  const ids = new Set<string>(DIRECTION_RULES.map((rule) => rule.id));
  return standards
    .filter((rule) => {
      const named = RuleIdSchema.safeParse(rule);
      return named.success && ids.has(named.data.id);
    })
    .map((rule) => StandardRuleSchema.parse(rule));
}

/**
 * A name no package has yet: a rule written as a list of what is refused
 * passes it, a rule written as what is allowed refuses it.
 */
export const NEW_PACKAGE = "@sf/zz-new";

/** The subpath every name is tried with as well: where a name ends is part of the rule. */
const SUBPATH = "zz-sub";

/**
 * `.claude/hooks/import-forms.js` by shape: the branches of the head of the
 * rules of direction and the forms of an import on one line, each with the
 * branch it is caught by and with each quote the hook reads. One table for
 * the probes of harness-selftest and for this check (E0-12V): a rule
 * has to say the same in every form, as `standards.js` meets them in the
 * lines being written. A form is a function of the module, so its result is
 * checked when it is called.
 */
const ImportFormsSchema = z
  .object({
    IMPORT_HEADS: z.array(z.string()).nonempty(),
    IMPORT_FORMS: z
      .array(
        z.object({
          head: z.string(),
          form: z.function().args(z.string()).returns(z.string()),
        }),
      )
      .nonempty(),
  })
  .superRefine((table, context) => {
    for (const { head } of table.IMPORT_FORMS) {
      if (!table.IMPORT_HEADS.includes(head)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `a form of the head ${head}, which IMPORT_HEADS does not have`,
        });
      }
    }
  });
type ImportForms = z.infer<typeof ImportFormsSchema>;

/** `hooks` (the module `.claude/hooks/import-forms.js` by default), checked by shape. */
export function readImportForms(
  hooks: unknown = createRequire(import.meta.url)(
    "../.claude/hooks/import-forms.js",
  ),
): ImportForms {
  return ImportFormsSchema.parse(hooks);
}

/** `matchAny` of `.claude/hooks/lib.js`: whether a glob of `files` takes `path`, as the hook picks the rules of a file. */
function hookMatchAny(): (files: readonly string[], path: string) => boolean {
  const lib: unknown = createRequire(import.meta.url)(
    "../.claude/hooks/lib.js",
  );
  if (
    typeof lib !== "object" ||
    lib === null ||
    !("matchAny" in lib) ||
    typeof lib.matchAny !== "function"
  ) {
    throw new Error(".claude/hooks/lib.js exports no matchAny");
  }
  const matchAny = lib.matchAny;
  return (files, path) =>
    Reflect.apply(matchAny, undefined, [files, path]) === true;
}

/**
 * Where the rules of standards of `DIRECTION_RULES` disagree with the table
 * `edges`, over the names of the packages of `workspace` and `NEW_PACKAGE`,
 * each also with a subpath. A rule has to be a line rule (`kind` as
 * `standards.js` reads it: an empty one is a line rule), its package has to
 * have a row in `edges` and to be in `workspace`, and the `files` of the
 * rule have to take every source file of that package in the zone of the
 * rule - not one sample: a rule narrowed to some of the files of its package
 * leaves the rest without a word. Then, for each name and in every form of
 * `readImportForms`, the line is refused when the pattern matches and its
 * `skipIf`, if any, does not - the reading of `standards.js`, which resets
 * the position of a global pattern before each line - and it has to be
 * refused exactly when the name is not the owner itself and the row of the
 * owner does not have it. For web, `@sf/config` and every subpath of it is
 * refused but exactly `WEB_CONFIG.entry`, as in its own code, and the entry
 * too when the row of web does not have `@sf/config`. A rule missing
 * from `rules` is a violation. A pattern that is not a regular expression
 * throws: the hook turns such a rule off without a word (`makeRe` gives
 * null), here it is an error with its reason.
 */
export function directionRuleViolations(
  rules: readonly StandardRule[],
  workspace: readonly WorkspacePackage[],
  edges: EdgeTable = ALLOWED_EDGES,
): string[] {
  const matchAny = hookMatchAny();
  const forms = readImportForms().IMPORT_FORMS;
  const violations: string[] = [];
  const names = workspace.map((pkg) => pkg.manifest.name);
  const everyName = [...new Set([...names, NEW_PACKAGE])];
  for (const { id, owner, zone } of DIRECTION_RULES) {
    const rule = rules.find((candidate) => candidate.id === id);
    if (rule === undefined) {
      violations.push(`${id}: no rule with this id in ${RULES_FILE}`);
      continue;
    }
    const row = Object.hasOwn(edges, owner) ? edges[owner] : undefined;
    if (row === undefined) {
      violations.push(`${id}: ${owner} is not in the table of allowed edges`);
      continue;
    }
    const kind = rule.kind || "line";
    if (kind !== "line") {
      violations.push(
        `${id}: kind ${kind}, a rule of direction is a line rule`,
      );
      continue;
    }
    const pkg = workspace.find(
      (candidate) => candidate.manifest.name === owner,
    );
    if (pkg === undefined) {
      violations.push(`${id}: ${owner} is not in the workspace`);
      continue;
    }
    const code = pkg.files
      .filter((file) => zone.test(file.path))
      .map((file) => `${pkg.dir}/${file.path}`);
    if (code.length === 0) {
      violations.push(
        `${id}: ${owner} has no source file for the files of the rule to take`,
      );
      continue;
    }
    const untaken = code.filter((path) => !matchAny(rule.files ?? [], path));
    if (untaken.length > 0) {
      violations.push(
        `${id}: the files of the rule do not take ${untaken.join(", ")}, of ${owner}`,
      );
      continue;
    }
    const pattern = new RegExp(rule.pattern, rule.flags ?? "");
    const skip =
      rule.skipIf === undefined
        ? null
        : new RegExp(rule.skipIf, rule.flags ?? "");
    const isRefusedLine = (line: string): boolean => {
      pattern.lastIndex = 0;
      if (!pattern.test(line)) return false;
      if (skip === null) return true;
      skip.lastIndex = 0;
      return !skip.test(line);
    };
    const expected: Array<readonly [string, boolean]> = everyName.flatMap(
      (name) => {
        const isRefused =
          (owner === WEB_CONFIG.from && name === WEB_CONFIG.to) ||
          (name !== owner && !row.includes(name));
        return [
          [name, isRefused],
          [`${name}/${SUBPATH}`, isRefused],
        ] as const;
      },
    );
    if (owner === WEB_CONFIG.from) {
      expected.push(
        [WEB_CONFIG.entry, !row.includes(WEB_CONFIG.to)],
        [`${WEB_CONFIG.entry}/${SUBPATH}`, true],
      );
    }
    for (const [specifier, isRefused] of expected) {
      const line = forms
        .map(({ form }) => form(specifier))
        .find((candidate) => isRefusedLine(candidate) !== isRefused);
      if (line === undefined) continue;
      violations.push(
        isRefused
          ? `${id} passes an edge the table does not have: ${owner} -> ${specifier}, in: ${line}`
          : `${id} refuses an edge of the table: ${owner} -> ${specifier}, in: ${line}`,
      );
    }
  }
  return violations;
}

/** `zod` and its subpaths (`zod/v4`). */
const ZOD = /^zod(?:\/|$)/;

/**
 * The files of every package that import `zod` without the manifest of
 * their package declaring it: a file that ships needs `zod` in
 * `dependencies` - the images install with `--prod` - and a file that never
 * ships (`NOT_SHIPPED`) has enough with `devDependencies`. The root manifest
 * is no package and is not read: its `zod` would cover nothing in an image.
 */
export function undeclaredZodImports(
  workspace: readonly WorkspacePackage[],
): string[] {
  const violations: string[] = [];
  for (const pkg of workspace) {
    const shipped = Object.hasOwn(pkg.manifest.dependencies ?? {}, "zod");
    const dev = Object.hasOwn(pkg.manifest.devDependencies ?? {}, "zod");
    for (const file of pkg.files) {
      const specifiers = importSpecifiers(file.path, file.text);
      if (!specifiers.some((specifier) => ZOD.test(specifier))) continue;
      const ships = !NOT_SHIPPED.some((pattern) => pattern.test(file.path));
      if (shipped || (!ships && dev)) continue;
      violations.push(
        `${pkg.dir}/${file.path}: zod is not in ${ships ? "dependencies" : "dependencies or devDependencies"} of ${pkg.dir}/package.json`,
      );
    }
  }
  return violations;
}

/**
 * The package a bare specifier names - `@scope/name` or `name`, subpath
 * dropped; null for a relative path, a `node:` builtin and an import that
 * cannot be read (`DYNAMIC_SPECIFIER`, refused by `importViolations`).
 */
function dependencyOf(specifier: string): string | null {
  if (
    specifier === DYNAMIC_SPECIFIER ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  return /^(?:@[^/]+\/)?[^/]+/.exec(specifier)?.[0] ?? null;
}

/**
 * The files that ship and import a package their manifest has in
 * `devDependencies` and not in `dependencies`: the images install with
 * `--prod`, so the import fails there with ERR_MODULE_NOT_FOUND (`vitest`
 * in `packages/core/src`, E0-12V). A file that never ships
 * (`NOT_SHIPPED`) and the config of a dev tool (`DEV_TOOL_CONFIGS`) take
 * their dev dependencies freely; a package in neither
 * field is not this check's. Only the imports that load at run time count
 * (`importSpecifiers` with `values`): a type-only import is erased by the
 * build. Every package of `workspace`, every file.
 */
export function devOnlyImports(
  workspace: readonly WorkspacePackage[],
): string[] {
  const violations: string[] = [];
  for (const pkg of workspace) {
    const shipped = pkg.manifest.dependencies ?? {};
    const dev = pkg.manifest.devDependencies ?? {};
    for (const file of pkg.files) {
      if (
        [...NOT_SHIPPED, ...DEV_TOOL_CONFIGS].some((pattern) =>
          pattern.test(file.path),
        )
      ) {
        continue;
      }
      const names = new Set(
        importSpecifiers(file.path, file.text, { values: true }).map(
          dependencyOf,
        ),
      );
      for (const name of names) {
        if (name === null || !Object.hasOwn(dev, name)) continue;
        if (Object.hasOwn(shipped, name)) continue;
        violations.push(
          `${pkg.dir}/${file.path}: ${name} is only in devDependencies of ${pkg.dir}/package.json, and the file ships`,
        );
      }
    }
  }
  return violations;
}
