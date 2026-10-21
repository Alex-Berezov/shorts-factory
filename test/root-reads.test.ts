import { describe, expect, it } from "vitest";
import { rootReads } from "./root-reads.js";

/**
 * What a file names that may reach outside its package (`test/root-reads.ts`):
 * each tie to the file, each path call it takes for one and each it does not,
 * read on the climbs it gives - from the file and from the package.
 */
function climbs(text: string, file = "test/x.test.ts") {
  const { fileClimb, packageClimb } = rootReads(file, text);
  return { fileClimb, packageClimb };
}

describe("rootReads", () => {
  it.each<[string, string, number, number]>([
    // Module specifiers, the ones that load nothing included.
    ["vi.unmock", 'vi.unmock("../../a.js");', 2, 0],
    ["vi.doUnmock", 'vi.doUnmock("../../../a.js");', 3, 0],
    ["require.resolve", 'require.resolve("../x.js");', 1, 0],
    // Ties to the file.
    ["__filename", 'resolve(__filename, "..", "..");', 2, 0],
    ["import.meta.filename", 'join(import.meta.filename, "../..");', 2, 0],
    [
      "the head of a template",
      // The text of a template with a substitution, put together.
      `new URL(\`../../$${"{name}"}\`, import.meta.url);`,
      2,
      0,
    ],
    [
      "the pathname of a URL of the file",
      'resolve(new URL(".", import.meta.url).pathname, "..", "..", "..");',
      3,
      0,
    ],
    [
      "a path that starts with ./",
      'new URL("./../..", import.meta.url);',
      2,
      0,
    ],
    [
      "a const of the file",
      'const here = import.meta.dirname;\nresolve(here, "..", "..");',
      2,
      0,
    ],
    // Path calls by their module.
    [
      "a default import of node:path",
      'import path from "node:path";\npath.join(__dirname, "..", "..");',
      2,
      0,
    ],
    [
      "posix of a namespace import of node:path",
      'import * as p from "node:path";\np.posix.join(__dirname, "../..");',
      2,
      0,
    ],
    [
      "a require of node:path",
      'const nodePath = require("node:path");\nnodePath.resolve(__dirname, "../..");',
      2,
      0,
    ],
    [
      "Promise.resolve, which builds no path",
      'Promise.resolve(import.meta.dirname, "../../..");',
      0,
      3,
    ],
    [
      "the join of an array, which builds no path",
      'parts.join(__dirname, "..", "..");',
      0,
      1,
    ],
    // Functions of the file that resolve their parameter against it.
    [
      "a function that reads its path against the file",
      'function read(path) {\n  return readFileSync(new URL(path, import.meta.url), "utf8");\n}\nread("../package.json");',
      1,
      0,
    ],
    [
      "an arrow that maps its paths against the file",
      'const exportsOf = (paths) =>\n  paths.map((p) => fileURLToPath(new URL(p, import.meta.url)));\nexportsOf(["../src/a.ts", "../../b.ts"]);',
      2,
      0,
    ],
    [
      "a function that joins its path to the file",
      'const at = (path) => join(import.meta.dirname, path);\nat("../../c");',
      2,
      0,
    ],
    [
      "the same text as a path the file resolved, as a key",
      'function read(path) {\n  return readFileSync(new URL(path, import.meta.url));\n}\nread("../src/a.ts");\nfound.get("../src/a.ts");',
      1,
      0,
    ],
    [
      "another text than the paths the file resolved",
      'function read(path) {\n  return readFileSync(new URL(path, import.meta.url));\n}\nread("../src/a.ts");\nfound.get("../src/b.ts");',
      1,
      1,
    ],
    [
      "a function that does not resolve its parameter",
      'function read(path) {\n  return readFileSync(path, "utf8");\n}\nread("../core/src/index.ts");',
      0,
      1,
    ],
    // Temporary directories.
    [
      "a path in a temporary directory",
      'const dir = mkdtempSync(join(tmpdir(), "x"));\nconst p = join(dir, "a");\njoin(p, "..", "..");',
      0,
      0,
    ],
    // Scope of a const.
    [
      "the const of its own block, not another of the same name",
      '{\n  const dir = process.cwd();\n  join(dir, "..", "..");\n}\n{\n  const dir = mkdtempSync("x");\n  join(dir, "..");\n}',
      0,
      2,
    ],
    [
      "a parameter hiding a const of the file",
      'const here = import.meta.dirname;\nfunction f(here) {\n  return resolve(here, "../..");\n}',
      0,
      2,
    ],
    [
      "a let, which may change",
      'let here = import.meta.dirname;\nresolve(here, "..", "..");',
      0,
      2,
    ],
    [
      "consts bound to each other",
      'const a = b;\nconst b = a;\nresolve(a, "..", "..");',
      0,
      2,
    ],
    // Paths tied to nothing.
    ["an absolute path", 'readFileSync("/../etc/x");', 0, 0],
    ["a literal of the package", 'readFileSync("../core/x.ts");', 0, 1],
  ])("reads %s", (_what, text, fileClimb, packageClimb) => {
    expect(climbs(text)).toEqual({ fileClimb, packageClimb });
  });

  it("collects the names and the strings of the file", () => {
    const found = rootReads(
      "test/x.test.ts",
      'const root = repoRoot;\nconst env = ".env.test";',
    );

    expect(found.names).toContain("repoRoot");
    expect(found.strings).toContain(".env.test");
  });

  it("takes the preset as climbing nothing in a vitest config only", () => {
    const text = 'import { unitTestConfig } from "../../vitest.preset.js";';

    expect(climbs(text, "vitest.config.ts").fileClimb).toBe(0);
    expect(climbs(text).fileClimb).toBe(2);
  });
});
