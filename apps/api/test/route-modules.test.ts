import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { instanceReaches, sourceFiles } from "./source-ast.js";

const ROUTES_DIR = fileURLToPath(new URL("../src/routes/", import.meta.url));

/** A module of `src/routes` around `lines`, the way the routes are written. */
function routeModule(lines: string[]): string {
  return [
    'import { defineRoute } from "../../lib/define-route.js";',
    "export function registerRoutes(registrar: RouteRegistrar, deps: AppDeps): void {",
    '  defineRoute(registrar, { method: "GET", url: "/x", responses, schema: {} }, async (request, reply) => {',
    ...lines.map((line) => `    ${line}`),
    '    return { status: "ok" as const };',
    "  });",
    "}",
  ].join("\n");
}

/**
 * The instance a module of `src/routes` could reach past its registrar: in a
 * handler or a hook of the route, `request.server`, `reply.server` and
 * `this` are the whole instance, typed without a cast. Fastify refuses a
 * route, a hook, a plugin or a decoration added there once the app is ready
 * (`test/instance-after-ready.test.ts`); `this` and the word `server` in any
 * position are refused here, in `pnpm test`, read off the syntax tree of
 * every source file of the directory at any depth (`source-ast.ts`). A key
 * computed at run time is beyond the reading (docs/adr/0015-route-registrar.md).
 */
describe("the modules of src/routes", () => {
  it("reach the instance nowhere", () => {
    const reaches = Object.fromEntries(
      sourceFiles(ROUTES_DIR).map((file) => [
        relative(ROUTES_DIR, file).replaceAll("\\", "/"),
        instanceReaches(file, readFileSync(file, "utf8")),
      ]),
    );
    // The walk did reach the modules: one that found no file would find no
    // `request.server` either. The other modules are not listed: a new one
    // is read like these, without a line here.
    expect(Object.keys(reaches)).toContain("index.ts");
    expect(Object.values(reaches).flat()).toEqual([]);
  });

  it.each([
    [
      "request.server.route(",
      'request.server.route({ method: "GET", url: "/y", handler });',
      ["4:13 server"],
    ],
    ["reply.server.get(", 'reply.server.get("/y", handler);', ["4:11 server"]],
    [
      "the server in a variable",
      "const srv = request.server;",
      ["4:25 server"],
    ],
    ["request?.server", "const srv = request?.server;", ["4:26 server"]],
    ['request["server"]', 'const srv = request["server"];', ['4:25 "server"']],
    ["a template key", "const srv = request[`server`];", ["4:25 `server`"]],
    [
      ".server on the next line",
      ["const srv = request", "  .server;"],
      ["5:8 server"],
    ],
    [
      "after the end of a comment",
      '/* the instance */ request.server.get("/y", handler);',
      ["4:32 server"],
    ],
    ["a binding", "const { server } = request;", ["4:13 server"]],
    ["a renamed binding", "const { server: srv } = reply;", ["4:13 server"]],
    [
      "a binding with a computed name",
      'const { ["server"]: srv } = request;',
      ['4:14 "server"'],
    ],
    [
      "a destructuring assignment",
      "({ server: srv } = request);",
      ["4:8 server"],
    ],
    [
      "a shorthand destructuring assignment",
      "({ server } = request);",
      ["4:8 server"],
    ],
    [
      "Reflect.get with the name",
      'const srv = Reflect.get(request, "server");',
      ['4:38 "server"'],
    ],
    ["a key of the deps", "const url = deps.config.server;", ["4:29 server"]],
    ["a variable named server", "const server = deps.health;", ["4:11 server"]],
    ["a key of a literal", "const options = { server: 1 };", ["4:23 server"]],
    ["an element of an array", "const [server] = list;", ["4:12 server"]],
    ["a private name", "class A { #server = 1; }", ["4:15 #server"]],
    [
      "this.route(",
      'this.route({ method: "GET", url: "/y", handler });',
      ["4:5 this"],
    ],
    ["this in a variable", "const self = this;", ["4:18 this"]],
    ["this to call", "register.call(this);", ["4:19 this"]],
    ["this destructured", "const { route } = this;", ["4:23 this"]],
  ])("refuses %s", (_form, lines, expected) => {
    expect(instanceReaches("index.ts", routeModule([lines].flat()))).toEqual(
      expected,
    );
  });

  it.each([
    ["this in a string", 'request.log.info("cannot undo this.");'],
    ["the server in a string", 'request.log.info("the server is up");'],
    ["the server in a comment", "// request.server is the whole instance"],
    ["the server in a block comment", "/* reply.server.get(...) */"],
    [
      "the request id and log",
      'request.log.info({ id: request.id }, "answered");',
    ],
    ["a name that only starts with server", "const kind = request.serverless;"],
  ])("lets through %s", (_form, line) => {
    expect(instanceReaches("index.ts", routeModule([line]))).toEqual([]);
  });
});
