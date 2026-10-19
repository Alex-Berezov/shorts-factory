import { describe, expect, it } from "vitest";
import { DYNAMIC_SPECIFIER, importSpecifiers } from "./imports.js";

/**
 * The one reader of imports of the root project (`test/imports.ts`): every
 * form it reads, every look-alike it does not, and the specifiers it cannot
 * read reported instead of skipped.
 */
describe("importSpecifiers", () => {
  it("reads every static form of import, and no comment, string or regex", () => {
    const text = [
      "// import { a } from '@sf/commented';",
      "/* import '@sf/block'; */",
      'import { b } from "@sf/b";',
      'import type { c } from "@sf/c";',
      'import "@sf/side";',
      'export * from "@sf/reexport";',
      'export { d } from "@sf/named";',
      'import g = require("@sf/equals");',
      'type H = typeof import("@sf/type");',
      "const s = `import x from '@sf/template'`;",
      "const re = /[\"']/; import k from '@sf/after-regex';",
      "const t = \"require('@sf/in-a-string')\";",
    ].join("\n");
    expect(importSpecifiers("a.ts", text)).toEqual([
      "@sf/b",
      "@sf/c",
      "@sf/side",
      "@sf/reexport",
      "@sf/named",
      "@sf/equals",
      "@sf/type",
      "@sf/after-regex",
    ]);
  });

  it("reads every call that loads or resolves a module", () => {
    const text = [
      'const e = await import("@sf/dynamic");',
      'const f = require("@sf/required");',
      'const p = require.resolve("@sf/resolved");',
      'const u = import.meta.resolve("@sf/meta-resolved");',
      'vi.mock("@sf/mocked");',
      'vi.doMock("@sf/do-mocked");',
      'const a = await vi.importActual("@sf/actual");',
      'const m = await vi.importMock("@sf/import-mocked");',
    ].join("\n");
    expect(importSpecifiers("a.test.ts", text)).toEqual([
      "@sf/dynamic",
      "@sf/required",
      "@sf/resolved",
      "@sf/meta-resolved",
      "@sf/mocked",
      "@sf/do-mocked",
      "@sf/actual",
      "@sf/import-mocked",
    ]);
  });

  it("reads vi.mock(import(...)) once, through its import", () => {
    expect(
      importSpecifiers("a.test.ts", 'vi.mock(import("@sf/typed-mock"));'),
    ).toEqual(["@sf/typed-mock"]);
  });

  it("passes calls that load nothing", () => {
    const text = [
      'vi.fn("@sf/not-a-module");',
      'vi.unmock("@sf/unmocked");',
      'other.resolve("@sf/not-require");',
      'myRequire("@sf/not-require-either");',
    ].join("\n");
    expect(importSpecifiers("a.test.ts", text)).toEqual([]);
  });

  it("reads no specifier from an export without from", () => {
    const text = ["export {};", "const a = 1;", "export { a };"].join("\n");
    expect(importSpecifiers("a.ts", text)).toEqual([]);
  });

  it.each([
    "await import(name);",
    "require(path);",
    "import x = require(name);",
    "vi.mock();",
    "require();",
    "require.resolve(`@sf/${name}`);",
    "import.meta.resolve(name);",
    "vi.mock(name);",
    "vi.importActual(name);",
  ])("reports a computed specifier instead of skipping it: %s", (text) => {
    expect(importSpecifiers("a.ts", text)).toEqual([DYNAMIC_SPECIFIER]);
  });

  it.each([
    'await import("./" + "../../config/src/index.js");',
    'await import("../test-support" + "/fixture");',
    "await import(`./locales/${lang}.js`);",
    'require(("./a-" + kind) + ".js");',
    "vi.mock(`../${name}`);",
  ])(
    "reports a computed specifier whatever text it starts with: %s",
    (text) => {
      expect(importSpecifiers("a.ts", text)).toEqual([DYNAMIC_SPECIFIER]);
    },
  );
});
