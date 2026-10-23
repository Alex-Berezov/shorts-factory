import ts from "typescript";

/**
 * The module specifiers a source file names, read from its syntax tree with
 * the `typescript` of the root devDependencies - the one way the root project
 * reads the imports of a file (decision of the tech lead, 19.10.2026, E0-12D,
 * docs/DECISIONS.md). A parser tells an import from a comment, a string or a
 * regular expression that merely contain one; a pattern over the text does
 * not, and `ts.preProcessFile` loses the imports after a regular expression
 * with a quote in it.
 */

/** What stands for a specifier that is not a string literal. */
export const DYNAMIC_SPECIFIER = "<dynamic>";

/** The methods of `vi` that load the module they are given. */
const VITEST_LOADERS = new Set([
  "mock",
  "doMock",
  "importActual",
  "importMock",
]);

/** The text of a string literal or a template without substitutions. */
export function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** `import("…")`, which the walk records on its own. */
function isImportCall(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * Whether `callee` loads or resolves the module named by its first argument:
 * `import(…)`, `require(…)`, `require.resolve(…)`, `import.meta.resolve(…)`,
 * `vi.mock(…)`, `vi.doMock(…)`, `vi.importActual(…)`, `vi.importMock(…)`.
 */
export function loadsModule(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = callee.expression;
  const name = callee.name.text;
  if (ts.isIdentifier(owner)) {
    return (
      (owner.text === "require" && name === "resolve") ||
      (owner.text === "vi" && VITEST_LOADERS.has(name))
    );
  }
  return (
    ts.isMetaProperty(owner) &&
    owner.keywordToken === ts.SyntaxKind.ImportKeyword &&
    name === "resolve"
  );
}

/**
 * Every module specifier `text` names, in the order of the file: static
 * `import`/`export … from`, a bare `import "…"`, `import x = require("…")`,
 * `typeof import("…")` in a type, and the calls of `loadsModule`. A call
 * whose specifier is not a string literal or a template without
 * substitutions comes back as `DYNAMIC_SPECIFIER`, whatever text it starts
 * with: what it loads cannot be checked, so it is reported rather than
 * skipped - except `vi.mock(import("…"))`, whose `import("…")` is read on
 * its own.
 */
export function importSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== null) found.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      found.push(literal(node.moduleReference.expression) ?? DYNAMIC_SPECIFIER);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) {
        found.push(literal(argument.literal) ?? DYNAMIC_SPECIFIER);
      }
    } else if (ts.isCallExpression(node) && loadsModule(node.expression)) {
      const argument = node.arguments[0];
      if (!isImportCall(argument)) {
        found.push(literal(argument) ?? DYNAMIC_SPECIFIER);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The path functions whose call with `repoRoot` first names a file. */
const PATH_CALLS = new Set(["join", "resolve"]);

/**
 * One use of the identifier `repoRoot` in a module, with its line (from 1):
 * - `path` - a `join(repoRoot, …)` or `resolve(repoRoot, …)` call (`join`,
 *   `resolve`, `path.join`, `path.resolve`): `path` is its parts after
 *   `repoRoot` joined with `/`, or `DYNAMIC_SPECIFIER` when a part is not a
 *   string literal or a template without substitutions;
 * - `other` - any other mention: an argument of another call
 *   (`relative(repoRoot, …)`, `dirname(repoRoot)`), a template, an alias
 *   (`import { repoRoot as root }`), a property, an array element.
 * The declaration of `repoRoot` and its import under its own name are not
 * uses.
 */
export type RepoRootUse =
  | { kind: "path"; callee: string; path: string; line: number }
  | { kind: "other"; line: number };

/**
 * Every use of `repoRoot` in a module, in the order of the file - what
 * `harness-selftest` takes for the files an integration run reads: a `path`
 * use is a read, an `other` use is a refusal to be checked by hand, since
 * what it reads cannot be told from the text. The text of a comment or a
 * string is not a use. Paths built from `new URL(…, import.meta.url)` or
 * `fileURLToPath` without `repoRoot` are not seen here.
 */
export function repoRootUses(fileName: string, text: string): RepoRootUse[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const consumed = new Set<ts.Node>();
  const found: RepoRootUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const [first, ...rest] = node.arguments;
      if (
        callee !== null &&
        PATH_CALLS.has(callee) &&
        first !== undefined &&
        isRepoRoot(first)
      ) {
        consumed.add(first);
        const parts: string[] = [];
        for (const part of rest) {
          const value = literal(part);
          if (value === null) break;
          parts.push(value);
        }
        found.push({
          kind: "path",
          callee,
          path:
            parts.length > 0 && parts.length === rest.length
              ? parts.join("/")
              : DYNAMIC_SPECIFIER,
          line: lineOf(node),
        });
      }
    } else if (
      isRepoRoot(node) &&
      !consumed.has(node) &&
      !declaresRepoRoot(node)
    ) {
      found.push({ kind: "other", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether `node` is the identifier `repoRoot`. */
function isRepoRoot(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === "repoRoot";
}

/**
 * Whether the identifier `repoRoot` names itself rather than uses a value:
 * the name of its `const`, or its import under the same name
 * (`import { repoRoot }`, not `import { repoRoot as root }`).
 */
function declaresRepoRoot(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isVariableDeclaration(parent)) return parent.name === node;
  return ts.isImportSpecifier(parent) && parent.propertyName === undefined;
}

/**
 * The name a call is made by: `join` of `join(…)` and of `path.join(…)`,
 * `resolve` of `resolve(…)` and of `path.resolve(…)`; null for any other
 * callee (`f()()`, `a[b]()`).
 */
export function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}
