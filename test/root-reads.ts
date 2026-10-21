import ts from "typescript";
import { calleeName, literal, loadsModule } from "./imports.js";

/**
 * What a source file of a package names that may reach outside the package,
 * read from its syntax tree with the `typescript` of the root devDependencies
 * (comments, regular expressions and the text of templates are the parser's
 * to tell apart, not a scan's). The rules of the turbo inputs
 * (`test/turbo-inputs.test.ts`) take a unit file for a reader of the root by
 * it; the reading of the imports themselves is `test/imports.ts`.
 */

/**
 * What `rootReads` finds in a file:
 *
 * - `names` - every identifier (`repoRoot`, `testEnvFilePath`, ...);
 * - `strings` - the text of every string literal and template part;
 * - `fileClimb` - the most directories a relative path climbs from the
 *   directory of the file: a module specifier (`import`, `import()`,
 *   `require`, `require.resolve`, `vi.mock`, `vi.unmock`, ...), or a path
 *   tied to the file - the literals of `new URL(x, import.meta.url)`, of a
 *   `resolve`/`join` whose first argument is the file (`import.meta.dirname`,
 *   `import.meta.filename`, `import.meta.url`, `__dirname`, `__filename`,
 *   `fileURLToPath(import.meta.url)`, a `dirname`, `resolve`, `join`,
 *   `fileURLToPath`, `new URL` or `.pathname` of one, or a `const` bound to
 *   one where the name stands - its nearest declaration, by scope), and the literals - alone or in an array literal -
 *   given to a function of the file that resolves its first parameter
 *   against the file (`read("../package.json")` with
 *   `function read(path) { … new URL(path, import.meta.url) … }`, or a
 *   `.map` of it);
 * - `packageClimb` - the same for every other literal: tied to nothing, it is
 *   taken from the directory the test runs in, the package (vitest's cwd), so
 *   any `..` there leaves the package - unless the file ties the same text
 *   to itself elsewhere (the key of a map of the paths it resolved), which
 *   names that path and climbs from the file.
 *
 * A literal climbs by its leading `..` segments, `.` among them skipped (`/`
 * or `\` between them: `"..\.."` and `"./../.."` are two; an absolute path
 * climbs nothing); a run of `resolve`/`join` arguments adds up while each is
 * only `..` (`resolve(here, "..", "..", "x")` is two). `resolve`, `join` and
 * `dirname` are path calls as a bare name or a method of `node:path` - its
 * default or namespace import, `path`, `posix` or `win32` - and
 * `fileURLToPath` as a bare name or a method of `node:url`: `Promise.resolve`,
 * `require.resolve` and `parts.join` build no path. A path call whose base is
 * a temporary directory (`tmpdir()`, `mkdtempSync(…)`, a path call or a
 * `const` of one) climbs inside it and counts nothing. The import of the
 * vitest preset by a `vitest.config.*` (`../../vitest.preset.js`) climbs
 * nothing: the preset is in the inputs of every `test`; any other mention of
 * it counts.
 *
 * Not seen: a path built from variables or calls (`dirname(dirname(here))`
 * climbs no more than `here`, `"..".repeat(3)`, `"../" + "../"`,
 * `` `${dir}/../..` `` past its head), a tie to the file through anything but
 * a `const` or a function of the same file, and what an imported module of
 * another package reads.
 */
export interface RootReads {
  names: ReadonlySet<string>;
  strings: readonly string[];
  fileClimb: number;
  packageClimb: number;
}

/** The import of the vitest preset by a vitest config, which climbs nothing. */
const PRESET_SPECIFIER = /(?:^|\/)vitest\.preset(?:\.[cm]?[jt]s)?$/;
const VITEST_CONFIG = /(?:^|\/)vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;

/** The path calls whose arguments make one path, the first argument its base. */
const PATH_CALLS = new Set(["resolve", "join"]);

/** The calls that keep their first argument tied to the file. */
const TIED_CALLS = new Set(["fileURLToPath", "dirname", "resolve", "join"]);

/** The calls whose result is a temporary directory. */
const TEMP_CALLS = new Set(["tmpdir", "mkdtempSync", "mkdtemp"]);

/** The modules whose functions build a path. */
const PATH_MODULES = new Set(["path", "node:path", "url", "node:url"]);

/** The names `node:path` and `node:url` go by without an import in sight. */
const PATH_RECEIVERS = ["path", "posix", "win32", "url"];

/** The methods of an array that hand its items to a function. */
const ITEM_METHODS = new Set(["map", "flatMap", "forEach"]);

/** The methods of `vi` that name a module, relative to the file, without loading it. */
const VITEST_UNMOCKS = new Set(["unmock", "doUnmock"]);

/** What the reading of one file knows of its bindings. */
interface Bindings {
  /** The names `node:path`/`node:url` are bound to. */
  pathModules: ReadonlySet<string>;
}

/**
 * The value of the `const` that `identifier` names where it stands: the
 * nearest declaration of the name in the blocks around it (a statement of
 * the block, or the head of a `for`), a parameter of a function around it
 * hiding any outer one. Undefined for a `let`, a `var`, a parameter, a
 * binding of a `for … of` or a name the file does not declare.
 */
function constValue(identifier: ts.Identifier): ts.Expression | undefined {
  const name = identifier.text;
  for (
    let node: ts.Node | undefined = identifier.parent;
    node !== undefined;
    node = node.parent
  ) {
    if (
      ts.isFunctionLike(node) &&
      node.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return undefined;
    }
    const lists: ts.VariableDeclarationList[] = [];
    if (
      ts.isBlock(node) ||
      ts.isSourceFile(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          lists.push(statement.declarationList);
        }
      }
    } else if (
      (ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForStatement(node)) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      lists.push(node.initializer);
    }
    for (const list of lists) {
      for (const declaration of list.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name
        ) {
          return (list.flags & ts.NodeFlags.Const) !== 0
            ? declaration.initializer
            : undefined;
        }
      }
    }
  }
  return undefined;
}

/** Leading `..` segments of a path, `.` skipped, and whether it is nothing else. */
function climbOfText(text: string): { up: number; only: boolean } {
  if (/^(?:[\\/]|[A-Za-z]:)/.test(text)) return { up: 0, only: false };
  const parts = text
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  let up = 0;
  while (parts[up] === "..") up += 1;
  return { up, only: up > 0 && up === parts.length };
}

/** The text of a literal or of the head of a template, null for other nodes. */
function pathText(node: ts.Node): string | null {
  const text = literal(node);
  if (text !== null) return text;
  return ts.isTemplateExpression(node) ? node.head.text : null;
}

/** Whether `node` is the module specifier of an import, of any form `importSpecifiers` reads. */
function isSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return ts.isImportTypeNode(parent.parent);
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) {
    return false;
  }
  const callee = parent.expression;
  return (
    loadsModule(callee) ||
    // `vi.unmock`/`vi.doUnmock` load nothing, but name a module by its path.
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "vi" &&
      VITEST_UNMOCKS.has(callee.name.text))
  );
}

/** Whether `node` is `require("<module>")` of one of `modules`. */
function isRequireOf(
  node: ts.Expression,
  modules: ReadonlySet<string>,
): boolean {
  if (!ts.isCallExpression(node)) return false;
  const name = literal(node.arguments[0]);
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    name !== null &&
    modules.has(name)
  );
}

/** The names the path modules go by in a file. */
function bindingsOf(source: ts.SourceFile): Bindings {
  const pathModules = new Set(PATH_RECEIVERS);
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      PATH_MODULES.has(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause?.name !== undefined) pathModules.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        pathModules.add(bindings.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      if (isRequireOf(node.initializer, PATH_MODULES)) {
        pathModules.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { pathModules };
}

/** Whether `node` is `node:path`/`node:url` or one of its `posix`/`win32`. */
function isPathModule(node: ts.Expression, bindings: Bindings): boolean {
  if (ts.isIdentifier(node)) return bindings.pathModules.has(node.text);
  return (
    ts.isPropertyAccessExpression(node) &&
    ["posix", "win32"].includes(node.name.text) &&
    isPathModule(node.expression, bindings)
  );
}

/**
 * The name of a call of a path function: a bare name, or a method of a path
 * module (`path.resolve`); null for a method of anything else
 * (`Promise.resolve`, `require.resolve`, `parts.join`).
 */
function pathCallName(
  callee: ts.Expression,
  bindings: Bindings,
): string | null {
  const name = calleeName(callee);
  if (name === null) return null;
  if (
    ts.isPropertyAccessExpression(callee) &&
    !isPathModule(callee.expression, bindings)
  ) {
    return null;
  }
  return name;
}

/** Whether `node` is the file or its directory (see `RootReads`). */
function tiedToFile(
  node: ts.Expression,
  bindings: Bindings,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (ts.isParenthesizedExpression(node)) {
    return tiedToFile(node.expression, bindings, seen);
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "__dirname" || node.text === "__filename") return true;
    const value = constValue(node);
    if (value === undefined || seen.has(node.text)) return false;
    return tiedToFile(value, bindings, new Set([...seen, node.text]));
  }
  if (ts.isPropertyAccessExpression(node)) {
    const owner = node.expression;
    if (
      ts.isMetaProperty(owner) &&
      owner.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      return ["url", "dirname", "filename"].includes(node.name.text);
    }
    // `new URL(…, import.meta.url).pathname`
    return tiedToFile(owner, bindings, seen);
  }
  if (ts.isNewExpression(node)) {
    const base = node.arguments?.[1];
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      base !== undefined &&
      tiedToFile(base, bindings, seen)
    );
  }
  if (ts.isCallExpression(node)) {
    const name = pathCallName(node.expression, bindings);
    const first = node.arguments[0];
    return (
      name !== null &&
      TIED_CALLS.has(name) &&
      first !== undefined &&
      tiedToFile(first, bindings, seen)
    );
  }
  return false;
}

/** Whether `node` is a temporary directory, or a path inside one. */
function tiedToTemp(
  node: ts.Expression,
  bindings: Bindings,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (ts.isParenthesizedExpression(node)) {
    return tiedToTemp(node.expression, bindings, seen);
  }
  if (ts.isIdentifier(node)) {
    const value = constValue(node);
    if (value === undefined || seen.has(node.text)) return false;
    return tiedToTemp(value, bindings, new Set([...seen, node.text]));
  }
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  if (name !== null && TEMP_CALLS.has(name)) return true;
  const first = node.arguments[0];
  return (
    first !== undefined &&
    PATH_CALLS.has(pathCallName(node.expression, bindings) ?? "") &&
    tiedToTemp(first, bindings, seen)
  );
}

/** The functions of a file, by name, each with its first parameter. */
function functionsOf(
  source: ts.SourceFile,
): Map<string, { parameter: string; body: ts.Node }> {
  const found = new Map<string, { parameter: string; body: ts.Node }>();
  const add = (name: string, fn: ts.FunctionLikeDeclaration): void => {
    const first = fn.parameters[0];
    if (first !== undefined && ts.isIdentifier(first.name) && fn.body) {
      found.set(name, { parameter: first.name.text, body: fn.body });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      add(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Whether `body` resolves `parameter` against the file: `new URL(p,
 * <the file>)`, or `p` after the base in a path call on the file - `p`
 * itself, or the parameter of a function `p.map`/`p.flatMap`/`p.forEach`
 * hands its items to.
 */
function resolvesAgainstFile(
  body: ts.Node,
  parameter: string,
  bindings: Bindings,
): boolean {
  const names = new Set([parameter]);
  const named = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && names.has(node.text);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const item = node.arguments[0];
      if (
        ts.isPropertyAccessExpression(callee) &&
        ITEM_METHODS.has(callee.name.text) &&
        named(callee.expression) &&
        item !== undefined &&
        (ts.isArrowFunction(item) || ts.isFunctionExpression(item))
      ) {
        const first = item.parameters[0];
        if (first !== undefined && ts.isIdentifier(first.name)) {
          names.add(first.name.text);
        }
      }
      const base = node.arguments[0];
      if (
        PATH_CALLS.has(pathCallName(callee, bindings) ?? "") &&
        base !== undefined &&
        tiedToFile(base, bindings) &&
        node.arguments.slice(1).some(named)
      ) {
        found = true;
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      const [path, base] = node.arguments ?? [];
      if (named(path) && base !== undefined && tiedToFile(base, bindings)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** The functions of the file that resolve their first parameter against it. */
function fileRelativeHelpers(
  source: ts.SourceFile,
  bindings: Bindings,
): Set<string> {
  const helpers = new Set<string>();
  for (const [name, { parameter, body }] of functionsOf(source)) {
    if (resolvesAgainstFile(body, parameter, bindings)) helpers.add(name);
  }
  return helpers;
}

/** What `fileName` (`text`) names that may reach outside its package (`RootReads`). */
export function rootReads(fileName: string, text: string): RootReads {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const config = VITEST_CONFIG.test(fileName);
  const bindings = bindingsOf(source);
  const helpers = fileRelativeHelpers(source, bindings);
  const names = new Set<string>();
  const strings: string[] = [];
  const handled = new Set<ts.Node>();
  /** The texts of the paths tied to the file. */
  const tied = new Set<string>();
  /** The literals tied to nothing, settled once every tied text is known. */
  const loose: string[] = [];
  let fileClimb = 0;
  let packageClimb = 0;
  const climb = (up: number, toFile: boolean): void => {
    if (toFile) fileClimb = Math.max(fileClimb, up);
    else packageClimb = Math.max(packageClimb, up);
  };
  const fromFile = (node: ts.Node, text: string): void => {
    handled.add(node);
    tied.add(text);
    climb(climbOfText(text).up, true);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      const [path, base] = node.arguments ?? [];
      const text = path === undefined ? null : pathText(path);
      if (path !== undefined && text !== null) {
        if (base !== undefined && tiedToFile(base, bindings)) {
          fromFile(path, text);
        } else {
          handled.add(path);
          climb(climbOfText(text).up, false);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = pathCallName(node.expression, bindings);
      const base = node.arguments[0];
      if (name !== null && PATH_CALLS.has(name) && base !== undefined) {
        const inTemp = tiedToTemp(base, bindings);
        const toFile = !inTemp && tiedToFile(base, bindings);
        let run = 0;
        for (const argument of node.arguments) {
          const text = pathText(argument);
          if (text === null) {
            run = 0;
            continue;
          }
          handled.add(argument);
          if (inTemp) continue;
          if (toFile) tied.add(text);
          const { up, only } = climbOfText(text);
          climb(run + up, toFile);
          run = only ? run + up : 0;
        }
      }
      const callee = node.expression;
      const first = node.arguments[0];
      if (
        ts.isIdentifier(callee) &&
        helpers.has(callee.text) &&
        first !== undefined
      ) {
        const items = ts.isArrayLiteralExpression(first)
          ? first.elements
          : [first];
        for (const item of items) {
          const text = pathText(item);
          if (text !== null) fromFile(item, text);
        }
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      strings.push(node.text);
    }
    const text = pathText(node);
    if (text !== null && !handled.has(node)) {
      if (!isSpecifier(node)) loose.push(text);
      else if (!(config && PRESET_SPECIFIER.test(text))) fromFile(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const text of loose) climb(climbOfText(text).up, tied.has(text));
  return { names, strings, fileClimb, packageClimb };
}
