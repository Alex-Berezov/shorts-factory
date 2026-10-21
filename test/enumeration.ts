import ts from "typescript";
import { calleeName, literal } from "./imports.js";

/**
 * The lock that keeps one listing of the files of the repository: a test of
 * the root project asks `test/repo-files.ts`, a script of `scripts/` asks
 * `trackedFiles` of `scripts/lib/files.mjs` - neither lists a directory of
 * the disk itself, which sees what no hash covers (`node_modules`, build
 * output, ignored files). Read from the syntax tree of a file: a string that
 * names a lister (the module a test preloads into a child, the script a
 * container runs) is no call.
 */

/** The modules of `node:fs` a file could list a directory with. */
const FS_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
]);

/** The functions of those modules that list a directory. */
const LISTERS = new Set([
  "readdirSync",
  "readdir",
  "opendirSync",
  "opendir",
  "globSync",
  "glob",
]);

/** The functions that look a path up on the disk. */
const LOOKUPS = new Set(["existsSync", "statSync", "lstatSync"]);

/** The end of the problem of a lookup, the one a disk check is let off. */
export const LOOKUP = " of a path under repoRoot";

/** Whether `node` is `require("<fs>")` or `import("<fs>")`, awaited or not. */
function loadsFs(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
    return loadsFs(node.expression);
  }
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const loader =
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require");
  const name = literal(node.arguments[0]);
  return loader && name !== null && FS_MODULES.has(name);
}

/** The name an element of a destructuring takes from its object. */
function propertyOf(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name;
  if (ts.isIdentifier(property)) return property.text;
  return literal(property);
}

/**
 * Where `file` lists a directory or looks a file of the repository up on
 * the disk: a lister of `node:fs` (`readdirSync`, `opendirSync`, `globSync`,
 * `readdir`, ...) taken by name - an import, a destructuring of the module
 * (`const { readdirSync } = fs`, of `require("node:fs")` or of
 * `await import("node:fs")`) - or reached through the module, however it is
 * had: a default or namespace import, a `const` of `require`/`import()` of
 * it, the call itself (`require("node:fs").readdirSync`), its `promises`
 * (`fs.promises.readdir`, `import { promises }`), by a dot or a bracket. And
 * `existsSync`/`statSync`/`lstatSync` - by its name, or by the one an import or
 * a destructuring of a module of `node:fs` gives it (`existsSync as e`) - with
 * `repoRoot` in its argument, or in the `const` the argument names. The temporary directories of fixtures
 * (`tmpdir()`) are no business of the lock.
 *
 * Not seen: a module of `node:fs` handed in from another file, or reached
 * through anything but a `const` of the same file.
 */
export function enumerationViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const where = (node: ts.Node): string =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const fsNames = new Set<string>();
  const consts = new Map<string, ts.Expression>();
  /** The local names of the lookups taken from a module of fs under another name. */
  const lookupNames = new Map<string, string>();

  /** Whether `node` is a module of `node:fs` (or its `promises`). */
  const isFs = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isFs(node.expression);
    if (ts.isIdentifier(node)) return fsNames.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === "promises" && isFs(node.expression);
    }
    return loadsFs(node);
  };

  // The names the modules go by, before any use of them is judged.
  const bind = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      FS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause?.name !== undefined) fsNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        fsNames.add(bindings.name.text);
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (name === "promises") fsNames.add(element.name.text);
          if (LOOKUPS.has(name)) lookupNames.set(element.name.text, name);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      if (ts.isIdentifier(node.name)) {
        consts.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(source);
  // A `const` of a module of fs, or of its `promises`, is one: to a fixed point.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, value] of consts) {
      if (!fsNames.has(name) && isFs(value)) {
        fsNames.add(name);
        grew = true;
      }
    }
    const destructure = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isFs(node.initializer)
      ) {
        for (const element of node.name.elements) {
          const taken = propertyOf(element);
          if (
            taken !== null &&
            LOOKUPS.has(taken) &&
            ts.isIdentifier(element.name)
          ) {
            lookupNames.set(element.name.text, taken);
          }
          if (
            taken === "promises" &&
            ts.isIdentifier(element.name) &&
            !fsNames.has(element.name.text)
          ) {
            fsNames.add(element.name.text);
            grew = true;
          }
        }
      }
      ts.forEachChild(node, destructure);
    };
    destructure(source);
  }

  /** Whether `node` is `repoRoot`, holds it, or is a `const` that does. */
  const namesRepoRoot = (
    node: ts.Node,
    seen: ReadonlySet<string> = new Set(),
  ): boolean => {
    if (ts.isIdentifier(node)) {
      if (node.text === "repoRoot") return true;
      const value = consts.get(node.text);
      return (
        value !== undefined &&
        !seen.has(node.text) &&
        namesRepoRoot(value, new Set([...seen, node.text]))
      );
    }
    return (
      ts.forEachChild(
        node,
        (child) => namesRepoRoot(child, seen) || undefined,
      ) === true
    );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      FS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (LISTERS.has(name)) {
            problems.push(`${where(element)}: imports ${name}`);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isFs(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const name = propertyOf(element);
        if (name !== null && LISTERS.has(name)) {
          problems.push(`${where(element)}: takes ${name}`);
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      LISTERS.has(node.name.text) &&
      isFs(node.expression)
    ) {
      problems.push(`${where(node)}: calls ${node.getText()}`);
    }
    if (ts.isElementAccessExpression(node) && isFs(node.expression)) {
      const name = literal(node.argumentExpression);
      if (name !== null && LISTERS.has(name)) {
        problems.push(`${where(node)}: calls ${node.getText()}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const name =
        callee !== null && ts.isIdentifier(node.expression)
          ? (lookupNames.get(callee) ?? callee)
          : callee;
      if (
        name !== null &&
        LOOKUPS.has(name) &&
        node.arguments.some((argument) => namesRepoRoot(argument))
      ) {
        problems.push(`${where(node)}: ${name}${LOOKUP}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
