import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * The sources of this app read as syntax trees, with the `typescript` of the
 * devDependencies: a parser tells code from a comment or a string that merely
 * mentions it, and sees a form across lines - what a pattern over the text of
 * a line cannot. Two readings live here: the instance a module of
 * `src/routes` reaches (`instanceReaches`, held in `route-modules.test.ts`) and
 * the modules a file imports (`importSpecifiers`, held in
 * `lib-layer.test.ts`).
 *
 * `importSpecifiers` is the third copy of the walk of `importSpecifiers` of
 * the root `test/imports.ts`, which a package may not import (ADR-0011), and
 * reads fewer forms than it does; one walk for the root and the apps is owed
 * (docs/TECH_DEBT.md, E0-12W).
 */

/** What stands for a specifier that is not a string literal. */
export const DYNAMIC_SPECIFIER = "<dynamic>";

/** What a source file of TypeScript is named: `.ts`, `.mts`, `.cts`, `.tsx`. */
const SOURCE_FILE = /\.[cm]?tsx?$/;

/**
 * Every source file of TypeScript under `dir` (`SOURCE_FILE`), at any depth,
 * by its absolute path, sorted.
 */
export function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

/** The text of a string literal or a template without substitutions. */
function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** The word no module of `src/routes` writes, in any position. */
const SERVER = "server";

/**
 * Every place `text` may reach the instance of Fastify past the registrar,
 * as `line:column form`: `this` in any position (`this.route(…)`,
 * `const self = this`, `.call(this)`, `const { route } = this`), and the word
 * `server` in any position of the code - as a name (`request.server`,
 * `reply?.server`, `.server` on the next line, `const { server } = request`,
 * `({ server: s } = request)`, `const server = …`, `const [server] = list`,
 * `{ server: 1 }`, `#server`) and as a string literal or a template without
 * substitutions (`request["server"]`, `Reflect.get(request, "server")`,
 * `const { ["server"]: s } = request`). No owner and no position is
 * excepted: a name that is not the instance is not worth the exception, and
 * a reading that tells one `server` from another misses the next form. A
 * comment, a string that only mentions the word (`"cannot undo this."`) and
 * a longer name (`request.serverless`) are not the word.
 *
 * What the reading does not see is the key computed at run time:
 * `request[key]`, `Object.values(request)`, `Object.entries(request)`,
 * `for (const key in request)` (docs/adr/0015-route-registrar.md).
 */
export function instanceReaches(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const found: string[] = [];
  const report = (node: ts.Node): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    found.push(`${line + 1}:${character + 1} ${node.getText(source)}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        node.text.replace(/^#/, "") === SERVER) ||
      literal(node) === SERVER
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Every module specifier `text` names, in the order of the file: static
 * `import`/`export … from` (type-only too - a cycle of types is a cycle), a
 * bare `import "…"`, `import x = require("…")`, `typeof import("…")` in a
 * type, `import("…")` and `require("…")`. A specifier that is not a string
 * literal comes back as `DYNAMIC_SPECIFIER`: what it loads cannot be checked,
 * so it is reported rather than skipped.
 */
export function importSpecifiers(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
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
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      found.push(literal(node.arguments[0]) ?? DYNAMIC_SPECIFIER);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
