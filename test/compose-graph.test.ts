import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { composeGraph } from "../scripts/lib/compose-graph.mjs";
import { readIfFile } from "../scripts/lib/files.mjs";
import { realpathIn } from "./compose-fixture.js";
import { dropLink } from "./drop-link.js";

/**
 * The reader of the graph of Compose files (scripts/lib/compose-graph.mjs),
 * over files held in memory: a case for each way a file names another, each
 * form of YAML Compose takes for it (measured on Compose 5.5.1,
 * tasks/2026-10-20-E0-12K.md), and each form the reader refuses rather than
 * reads as clean.
 */

const ROOT = resolve("/srv/sf");
/** A path under the root of the fixture. */
function at(...parts: string[]): string {
  return join(ROOT, ...parts);
}
const ENTRY = at("compose.yaml");
const INCLUDED = at("inc.yml");
const SERVICE = "services:\n  api:\n    image: x\n";
/** Every file may be read: the cases of the walk itself, not of its bounds. */
const ADMIT_ALL = () => true;

/** The graph of `ENTRY` over `files` (path -> contents), with `links`. */
function graph(
  files: Record<string, string>,
  links: Record<string, string> = {},
) {
  return composeGraph(ENTRY, {
    read: (path) => files[path] ?? null,
    realpath: realpathIn(files, links),
    admits: ADMIT_ALL,
  });
}

/** The graph of a root file with `text`, next to `inc.yml`. */
function rootWith(text: string) {
  return graph({ [ENTRY]: text, [INCLUDED]: SERVICE });
}

/** The graph of `rootWith(text)` when the root file names no other. */
function entryAlone(text: string) {
  return {
    files: [ENTRY],
    roots: [{ file: ENTRY, root: parse(text, { merge: true }) }],
    references: [],
    problems: [],
  };
}

describe("composeGraph: the edges", () => {
  it("follows an include given as a path", () => {
    const result = rootWith(`include:\n  - inc.yml\n${SERVICE}`);

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(result.references).toEqual([
      { from: ENTRY, field: "include[0]", written: INCLUDED, target: INCLUDED },
    ]);
  });

  it("follows an include given as a mapping with path", () => {
    const result = rootWith("include:\n  - path: inc.yml\n");

    expect(result.problems).toEqual([]);
    expect(result.references.map((ref) => ref.field)).toEqual([
      "include[0].path",
    ]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
  });

  it("follows every path of an include whose path is a list", () => {
    const other = at("other.yml");
    const result = graph({
      [ENTRY]: "include:\n  - path: [inc.yml, other.yml]\n",
      [INCLUDED]: SERVICE,
      [other]: SERVICE,
    });

    expect(result.problems).toEqual([]);
    expect(result.references.map((ref) => ref.field)).toEqual([
      "include[0].path[0]",
      "include[0].path[1]",
    ]);
    expect(result.files).toEqual([ENTRY, INCLUDED, other]);
  });

  it("follows an include of an included file, from its own directory", () => {
    const first = at("infra", "a.yml");
    const second = at("infra", "b.yml");
    const result = graph({
      [ENTRY]: "include:\n  - infra/a.yml\n",
      [first]: "include:\n  - b.yml\n",
      [second]: SERVICE,
    });

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, first, second]);
    expect(result.references[1]).toEqual({
      from: first,
      field: "include[0]",
      written: second,
      target: second,
    });
  });

  it("follows the file of an extends of a service", () => {
    const result = rootWith(
      "services:\n  api:\n    extends:\n      file: inc.yml\n      service: api\n",
    );

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(result.references.map((ref) => ref.field)).toEqual([
      "services.api.extends.file",
    ]);
  });

  it.each([
    ["a service name", "extends: base"],
    ["a mapping with service alone", "extends:\n      service: base"],
  ])("takes no edge from an extends with %s - the same file", (_case, form) => {
    const text = `services:\n  base:\n    image: b\n  api:\n    ${form}\n`;
    const result = rootWith(text);

    expect(result).toEqual(entryAlone(text));
  });

  it("takes the extends of environment and of labels for values, not edges", () => {
    // Shaped as an extends of a service, so a reader that looked past
    // `services.<name>.extends` would take an edge (T8, E0-12C).
    const text =
      "services:\n  api:\n    image: x\n    environment:\n      extends:\n        file: inc.yml\n        service: api\n    labels:\n      extends: inc.yml\n";
    const result = rootWith(text);

    expect(result).toEqual(entryAlone(text));
  });

  it("takes an include that is null for none, as Compose does", () => {
    // `include:` with no value: Compose renders the services of the file
    // (measured on Compose 5.5.1, C11 E0-12K).
    const text = `include:\n${SERVICE}`;
    const result = rootWith(text);

    expect(result).toEqual(entryAlone(text));
  });

  it("takes an extends outside services for no edge", () => {
    const text = `x-base:\n  extends:\n    file: inc.yml\n    service: api\n${SERVICE}`;
    const result = rootWith(text);

    expect(result).toEqual(entryAlone(text));
  });
});

/**
 * The root mapping of each file read, for rule 17 of scripts/compose-rules.mjs
 * to read the values of the stack in, not by a parse of its own (E1, E0-12K).
 */
describe("composeGraph: the roots", () => {
  it("hands back the root of every file of the graph, in the order of the walk", () => {
    const base = at("infra", "base.yml");
    const result = graph({
      [ENTRY]: "include:\n  - inc.yml\n",
      [INCLUDED]:
        "x-env: &env\n  A: b\nservices:\n  api:\n    extends:\n      file: infra/base.yml\n      service: api\n    environment:\n      <<: *env\n      C:\n",
      [base]: "services:\n  api:\n    environment: [D]\n",
    });

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED, base]);
    expect(result.roots).toEqual([
      { file: ENTRY, root: { include: ["inc.yml"] } },
      {
        file: INCLUDED,
        root: {
          "x-env": { A: "b" },
          services: {
            api: {
              extends: { file: "infra/base.yml", service: "api" },
              environment: { A: "b", C: null },
            },
          },
        },
      },
      { file: base, root: { services: { api: { environment: ["D"] } } } },
    ]);
  });

  it("hands back no root for a file it could not read whole", () => {
    const result = graph({
      [ENTRY]: "include:\n  - inc.yml\n",
      [INCLUDED]: "- not a mapping\n",
    });

    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(result.roots).toEqual([
      { file: ENTRY, root: { include: ["inc.yml"] } },
    ]);
    expect(result.problems).toEqual([`${INCLUDED}: the root is not a mapping`]);
  });
});

/**
 * The forms of a file Compose reads as an include or an extends (measured,
 * tasks/2026-10-20-E0-12K.md, «S2»): each finds the file it names.
 */
describe("composeGraph: the forms of YAML Compose takes", () => {
  const EXTENDS = "services.api.extends.file";
  it.each([
    ["a quoted key", `"include":\n  - inc.yml\n`, "include[0]"],
    [
      "a key with a space before its colon",
      "include :\n  - inc.yml\n",
      "include[0]",
    ],
    ["an indented document", "  include:\n    - inc.yml\n", "include[0]"],
    ["a JSON root", '{"include": ["inc.yml"]}\n', "include[0]"],
    [
      "a flow mapping of extends",
      "services:\n  api:\n    extends: {file: inc.yml, service: api}\n",
      EXTENDS,
    ],
    ["a BOM", "\ufeffinclude:\n  - inc.yml\n", "include[0]"],
    [
      "an escape in double quotes",
      'include:\n  - "inc\\x2eyml"\n',
      "include[0]",
    ],
    ["an escaped key", '"\\u0069nclude":\n  - inc.yml\n', "include[0]"],
    [
      "a single-quoted extends",
      "services:\n  api:\n    'extends':\n      file: inc.yml\n      service: api\n",
      EXTENDS,
    ],
    [
      "a merge key in extends",
      "x-base: &base\n  file: inc.yml\n  service: api\nservices:\n  api:\n    extends:\n      <<: *base\n",
      EXTENDS,
    ],
    [
      "an alias of the path",
      "x-inc: &inc inc.yml\ninclude:\n  - *inc\n",
      "include[0]",
    ],
  ])("finds the file named with %s", (_case, text, field) => {
    const result = rootWith(text);

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(result.references.map((ref) => ref.field)).toEqual([field]);
  });
});

describe("composeGraph: what it refuses", () => {
  it.each([
    [
      "two documents",
      `${SERVICE}---\ninclude:\n  - inc.yml\n`,
      "2 YAML documents - Compose reads every one, the gate reads a file of one",
    ],
    ["an empty file", "", "no YAML document - Compose refuses an empty file"],
    [
      "the tag !reset",
      `include: !reset []\n${SERVICE}`,
      "TAG_RESOLVE_FAILED at line 1 - the gate does not read a file the parser does not take as it is",
    ],
    [
      "the tag !override",
      "include: !override\n  - inc.yml\n",
      "TAG_RESOLVE_FAILED at line 1 - the gate does not read a file the parser does not take as it is",
    ],
    [
      "a parse error",
      "include: [inc.yml\n",
      "BAD_INDENT at line 2 - the gate does not read a file the parser does not take as it is",
    ],
    ["a root that is a list", "- inc.yml\n", "the root is not a mapping"],
    ["a root that is a word", "inc.yml\n", "the root is not a mapping"],
    // Compose 5.5.1 answers "top-level object must be a mapping" on a file of
    // one `---`, and "empty compose file" on a file of comments (measured, D8).
    ["a file of one ---", "---\n", "the root is not a mapping"],
    [
      "a file of comments",
      "# no stack\n",
      "no YAML document - Compose refuses an empty file",
    ],
    [
      "an include that is not a list",
      "include: inc.yml\n",
      "include is not a list",
    ],
    [
      "an entry of include in another form",
      "include:\n  - 1\n",
      "include[0] is neither a path nor a mapping with path",
    ],
    [
      "project_directory in an include",
      "include:\n  - path: inc.yml\n    project_directory: ..\n",
      "include[0].project_directory - an include takes path alone, the gate checks no other field",
    ],
    [
      "env_file in an include",
      "include:\n  - path: inc.yml\n    env_file: x.env\n",
      "include[0].env_file - an include takes path alone, the gate checks no other field",
    ],
    [
      "a path of an include in another form",
      "include:\n  - path: {a: b}\n",
      "include[0].path is neither a path nor a list of paths",
    ],
    [
      "an entry of a list of paths in another form",
      "include:\n  - path: [1]\n",
      "include[0].path[0] is not a path",
    ],
    [
      "services that are not a mapping",
      "services: [api]\n",
      "services is not a mapping",
    ],
    [
      // Compose refuses it too: `services must be a mapping` (measured).
      "services that are null",
      "services:\n",
      "services is not a mapping",
    ],
    [
      "a service that is not a mapping",
      "services:\n  api: x\n",
      "services.api is not a mapping",
    ],
    [
      "an extends in another form",
      "services:\n  api:\n    extends: [base]\n",
      "services.api.extends is neither a service name nor a mapping with service",
    ],
    [
      "an extends with another key",
      "services:\n  api:\n    extends:\n      service: base\n      path: inc.yml\n",
      "services.api.extends.path - an extends takes service and file alone",
    ],
    [
      "an extends without a service name",
      "services:\n  api:\n    extends:\n      file: inc.yml\n",
      "services.api.extends.service is not a service name",
    ],
    [
      "a file of extends that is not a path",
      "services:\n  api:\n    extends:\n      service: base\n      file: [inc.yml]\n",
      "services.api.extends.file is not a path",
    ],
  ])("refuses %s", (_case, text, problem) => {
    const result = rootWith(text);

    expect(result.problems).toEqual([`${ENTRY}: ${problem}`]);
  });

  it.each([
    ["${X}", "include:\n  - infra/${X}.yml\n", "infra/${X}.yml"],
    ["$X", "include:\n  - $X/inc.yml\n", "$X/inc.yml"],
    ["$$", "include:\n  - path: a$$b.yml\n", "a$$b.yml"],
  ])(
    "refuses a path with %s before it is joined to anything",
    (_case, text, path) => {
      const realpath = vi.fn(realpathIn({ [INCLUDED]: SERVICE }));

      const result = composeGraph(ENTRY, {
        read: (file) => (file === ENTRY ? text : null),
        realpath,
        admits: ADMIT_ALL,
      });

      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(
        `is an interpolated path (${path}) - Compose fills it in from .env, the gate cannot know the file`,
      );
      expect(realpath).toHaveBeenCalledTimes(0);
      expect(result.files).toEqual([ENTRY]);
    },
  );

  it("names a target that is not there", () => {
    const result = graph({ [ENTRY]: "include:\n  - gone.yml\n" });

    expect(result.problems).toEqual([
      `${ENTRY}: include[0] names ${at("gone.yml")}, which is not there`,
    ]);
    expect(result.files).toEqual([ENTRY]);
  });

  it("throws a failure of the realpath other than a path that is not there", () => {
    const denied = Object.assign(new Error("EACCES: realpath"), {
      code: "EACCES",
    });

    expect(() =>
      composeGraph(ENTRY, {
        read: () => "include:\n  - inc.yml\n",
        realpath: () => {
          throw denied;
        },
        admits: ADMIT_ALL,
      }),
    ).toThrow(denied);
  });

  it("names an entry that is not a file", () => {
    const result = graph({});

    expect(result.problems).toEqual([`${ENTRY}: not a file`]);
    expect(result.files).toEqual([ENTRY]);
  });

  it("refuses a cyclic alias rather than walking it", () => {
    const result = rootWith(`x-loop: &loop [*loop]\n${SERVICE}`);

    expect(result.problems).toEqual([
      `${ENTRY}: a cyclic alias - Compose refuses it`,
    ]);
  });

  it("refuses aliases that expand past the limit", () => {
    const nine = (alias: string) => Array(9).fill(alias).join(", ");
    const text = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      `b: &b [${nine("*a")}]`,
      `c: &c [${nine("*b")}]`,
      `d: [${nine("*c")}, ${nine("*c")}]`,
      "",
    ].join("\n");

    const result = rootWith(text);

    expect(result.problems).toEqual([
      `${ENTRY}: aliases the gate does not expand (past maxAliasCount)`,
    ]);
  });

  it("names the reason of a value the parser cannot build, not the alias limit", () => {
    const result = rootWith(
      "x-a: &a [1]\nservices:\n  api:\n    <<: *a\n    image: x\n",
    );

    expect(result.problems).toEqual([
      `${ENTRY}: the parser cannot build it (Merge sources must be maps or map aliases)`,
    ]);
  });

  it("takes an alias shared by two fields for no cycle", () => {
    const text =
      "x-env: &env {A: b}\nservices:\n  api:\n    image: x\n    environment: *env\n  web:\n    image: y\n    environment: *env\n";
    const result = rootWith(text);

    expect(result).toEqual(entryAlone(text));
  });

  it("reads a file named twice once", () => {
    const result = rootWith("include:\n  - inc.yml\n  - path: inc.yml\n");

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(result.references).toHaveLength(2);
  });

  it("reads a cycle of files once each and ends", () => {
    const read = vi.fn((path: string): string | null =>
      path === ENTRY
        ? "include:\n  - inc.yml\n"
        : "include:\n  - compose.yaml\n",
    );

    const result = composeGraph(ENTRY, {
      read,
      realpath: realpathIn({ [ENTRY]: "", [INCLUDED]: "" }),
      admits: ADMIT_ALL,
    });

    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([ENTRY, INCLUDED]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.references.map((ref) => ref.target)).toEqual([
      INCLUDED,
      ENTRY,
    ]);
  });
});

/**
 * The files the caller admits (`COMPOSE_SOURCES` for the compose gate): a file
 * outside is named by its edge and never opened, so nothing outside the
 * Compose files of the stack - a `.env`, say - is read on the way (P1, E0-12K).
 */
describe("composeGraph: the files it admits", () => {
  const OUTSIDE = at("deploy", "evil.yml");

  it("does not read a file it does not admit, and keeps its edge", () => {
    const files = { [ENTRY]: "include:\n  - inc.yml\n", [INCLUDED]: SERVICE };
    const read = vi.fn((path: string): string | null => files[path] ?? null);

    const result = composeGraph(ENTRY, {
      read,
      realpath: realpathIn(files),
      admits: (path) => path === ENTRY,
    });

    expect(result).toEqual({
      files: [ENTRY],
      roots: [{ file: ENTRY, root: { include: ["inc.yml"] } }],
      references: [
        {
          from: ENTRY,
          field: "include[0]",
          written: INCLUDED,
          target: INCLUDED,
        },
      ],
      problems: [],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ENTRY);
  });

  it("does not read an admitted path that is a link to a file it does not admit", () => {
    const files = { [ENTRY]: "include:\n  - inc.yml\n", [OUTSIDE]: SERVICE };
    const read = vi.fn((path: string): string | null => files[path] ?? null);

    const result = composeGraph(ENTRY, {
      read,
      realpath: realpathIn(files, { [INCLUDED]: OUTSIDE }),
      admits: (path) => path !== OUTSIDE,
    });

    expect(result.files).toEqual([ENTRY]);
    expect(result.references.map((ref) => ref.target)).toEqual([OUTSIDE]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ENTRY);
  });

  it("refuses a walk without admits rather than opening every file", () => {
    // Without a list of the caller an include would open a `.env` (C1, E0-12K).
    const read = vi.fn((): string | null => "include:\n  - .env\n");
    const readers = { read, realpath: realpathIn({}) };

    expect(() =>
      // @ts-expect-error: admits left out on purpose, as a plain .mjs caller may
      composeGraph(ENTRY, readers),
    ).toThrow(
      new TypeError(
        "composeGraph: admits is required - the files the walk may open",
      ),
    );
    expect(read).toHaveBeenCalledTimes(0);
  });

  it("does not read an entry it does not admit", () => {
    const read = vi.fn((): string | null => SERVICE);

    const result = composeGraph(ENTRY, {
      read,
      realpath: realpathIn({}),
      admits: () => false,
    });

    expect(result).toEqual({
      files: [],
      roots: [],
      references: [],
      problems: [],
    });
    expect(read).toHaveBeenCalledTimes(0);
  });
});

/**
 * A link on disk, by the native realpath: the edge names the path as written
 * and the file the link leads to (T3, E0-12C). A junction, since a symlink to
 * a file needs rights Windows does not give by default.
 */
describe("composeGraph: a link on disk", () => {
  let scratch = "";
  let link = "";
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "sf-compose-graph-"));
    link = join(scratch, "infra", "link");
  });
  afterAll(() => {
    // No directory was made: nothing to take off.
    if (scratch === "") return;
    // The link goes first on its own: a recursive remove must never walk
    // through it. A failure to take it off throws, and the remove does not run.
    dropLink(link);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("resolves an include through a junction to the file it leads to", () => {
    mkdirSync(join(scratch, "infra"));
    mkdirSync(join(scratch, "deploy"));
    writeFileSync(join(scratch, "deploy", "evil.yml"), SERVICE);
    const entry = join(scratch, "compose.yaml");
    writeFileSync(entry, "include:\n  - infra/link/evil.yml\n");
    symlinkSync(join(scratch, "deploy"), link, "junction");
    const canonicalEntry = realpathSync.native(entry);

    const result = composeGraph(canonicalEntry, {
      read: readIfFile,
      realpath: realpathSync.native,
      admits: ADMIT_ALL,
    });

    const target = realpathSync.native(join(scratch, "deploy", "evil.yml"));
    expect(result.problems).toEqual([]);
    expect(result.files).toEqual([canonicalEntry, target]);
    expect(result.references).toEqual([
      {
        from: canonicalEntry,
        field: "include[0]",
        written: join(
          realpathSync.native(scratch),
          "infra",
          "link",
          "evil.yml",
        ),
        target,
      },
    ]);
  });
});
