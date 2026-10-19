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
function literal(node: ts.Node | undefined): string | null {
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
function loadsModule(callee: ts.Expression): boolean {
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
