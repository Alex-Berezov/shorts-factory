import type * as Fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import drizzleConfig from "../packages/db/drizzle.config.js";
import {
  DB_DIR,
  DRIZZLE_CONFIG,
  DRIZZLE_KIT_RUNS,
  DRIZZLE_KIT_TIMEOUT_MS,
  DRIZZLE_KIT_VERSION,
  HINTS,
  STALE_COPY_MS,
  changesOf,
  classifyCheck,
  classifyGenerate,
  filesOf,
  installedVersion,
  main,
  outOf,
  runEntry,
  spawnDrizzleKit,
  versionOf,
} from "../scripts/check-schema-drift.mjs";
import { timedOut } from "../scripts/lib/files.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { chosenOn, gateOf } from "./gate-choice.js";
import {
  AMBIGUOUS_RENAME,
  CHECK_FINE,
  CLEAN_TREE,
  LINUX_AMBIGUOUS_RENAME,
  LINUX_SNAPSHOT_COLLISION_RUN,
  MALFORMED_SNAPSHOT_CHECK,
  NEW_COLUMN,
  NEW_COLUMN_CHANGES,
  RECORDED_VERSION,
  type RecordedRun,
  SNAPSHOT_COLLISION_CHECK,
  SNAPSHOT_COLLISION_RUN,
} from "./schema-drift-fixture.js";

/**
 * The gate of the schema drift (scripts/check-schema-drift.mjs) on the output
 * drizzle-kit 0.28.1 printed when it was recorded (schema-drift-fixture.ts):
 * no drizzle-kit is reached - each run gets fakes of it that print a recorded
 * output and write into the copy of the folder what drizzle-kit would. The
 * folder is a scratch package of its own. A case for each way a run ends,
 * and the exit code it ends with: 0 clean, 1 drift, 2 a check that did not
 * take place.
 */

type Deps = NonNullable<Parameters<typeof main>[1]>;
type Spawn = NonNullable<Deps["runGenerate"]>;
type SpawnSpec = Parameters<Spawn>[0];
type SpawnResult = ReturnType<Spawn>;

/** A recorded run as the spawn of the script returns it. */
function spawned(run: RecordedRun): SpawnResult {
  return {
    status: run.status,
    signal: null,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

/** The output a generate prints when it is cut before its closing line. */
const CUT_SHORT = CLEAN_TREE.stdout.slice(
  0,
  CLEAN_TREE.stdout.indexOf("No schema changes"),
);

/** A failed spawn with `code`, as node gives it. */
function failedSpawn(code: string): SpawnResult {
  const error = Object.assign(new Error(`spawnSync node ${code}`), { code });
  return {
    status: null,
    signal: code === "ETIMEDOUT" || code === "ENOBUFS" ? "SIGTERM" : null,
    stdout: "",
    stderr: "",
    error,
  };
}

/** The folder `--out` of a spec of generate names. */
function copyOf(spec: SpawnSpec): string {
  const at = spec.args.indexOf("--out");
  const out = spec.args[at + 1];
  if (at === -1 || out === undefined) throw new Error("no --out");
  return resolve(spec.cwd, out);
}

/** Writes `files` (path from the folder -> content) under `dir`. */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** The migrations folder of the scratch package, as committed. */
const COMMITTED = {
  "0000_core.sql": "CREATE TABLE a (id serial);\n",
  "meta/_journal.json": '{"entries":[{"tag":"0000_core"}]}\n',
  "meta/0000_snapshot.json": '{"id":"a","prevId":"0"}\n',
};

/** What generate writes for `NEW_COLUMN`, `NEW_COLUMN_CHANGES` by name. */
const NEW_COLUMN_FILES = {
  "0001_demonic_invisible_woman.sql":
    'ALTER TABLE a ADD COLUMN "drift_probe" text;\n',
  "meta/0001_snapshot.json": '{"id":"b","prevId":"a"}\n',
  "meta/_journal.json":
    '{"entries":[{"tag":"0000_core"},{"tag":"0001_demonic_invisible_woman"}]}\n',
};

/**
 * A generate that does what drizzle-kit does on a schema with a new column:
 * writes the migration into its `--out` unless the folder holds it already,
 * and says which it did.
 */
const generateLikeDrizzleKit: Spawn = (spec) => {
  const copy = copyOf(spec);
  if (existsSync(join(copy, "0001_demonic_invisible_woman.sql"))) {
    return spawned(CLEAN_TREE);
  }
  writeFiles(copy, NEW_COLUMN_FILES);
  return spawned(NEW_COLUMN);
};

let dbDir = "";

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "sf-drift-db-"));
  writeFiles(join(dbDir, "migrations"), COMMITTED);
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

interface Fakes {
  generate?: SpawnResult | Spawn;
  check?: SpawnResult;
  version?: string | Error;
  tempRoot?: string;
  relativeOf?: Deps["relativeOf"];
  removeDir?: Deps["removeDir"];
  now?: Deps["now"];
}

function run({
  generate = spawned(CLEAN_TREE),
  check = spawned(CHECK_FINE),
  version = DRIZZLE_KIT_VERSION,
  tempRoot,
  relativeOf,
  removeDir,
  now,
}: Fakes = {}) {
  const copies: string[] = [];
  const runGenerate = vi.fn<Spawn>((spec) => {
    copies.push(copyOf(spec));
    return typeof generate === "function" ? generate(spec) : generate;
  });
  const runCheck = vi.fn<Spawn>(() => check);
  const out: string[] = [];
  const err: string[] = [];
  const code = main([], {
    runGenerate,
    runCheck,
    readVersion: () => {
      if (version instanceof Error) throw version;
      return version;
    },
    dbDir,
    ...(tempRoot === undefined ? {} : { tempRoot }),
    ...(relativeOf === undefined ? {} : { relativeOf }),
    ...(removeDir === undefined ? {} : { removeDir }),
    ...(now === undefined ? {} : { now }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    runGenerate,
    runCheck,
    copies,
  };
}

describe("the recorded output", () => {
  it("is of the version the script expects", () => {
    expect(RECORDED_VERSION).toBe(DRIZZLE_KIT_VERSION);
  });
});

describe("classifyGenerate", () => {
  const ended = (recorded: RecordedRun) => ({
    output: `${recorded.stdout}${recorded.stderr}`,
    status: recorded.status,
    signal: null,
    timedOut: false,
  });

  it("reads a clean tree", () => {
    expect(classifyGenerate(ended(CLEAN_TREE))).toBe("clean");
  });

  it("reads a migration it wrote", () => {
    expect(classifyGenerate(ended(NEW_COLUMN))).toBe("wrote");
  });

  it("reads the question of an ambiguous rename, exit 0", () => {
    expect(classifyGenerate(ended(AMBIGUOUS_RENAME))).toBe("rename_question");
  });

  it("reads colliding snapshots, exit 0", () => {
    expect(classifyGenerate(ended(SNAPSHOT_COLLISION_RUN))).toBe(
      "snapshot_collision",
    );
  });

  it("puts a collision before a question of a rename in the same output", () => {
    const both = {
      ...ended(AMBIGUOUS_RENAME),
      output: `${SNAPSHOT_COLLISION_RUN.stdout}${AMBIGUOUS_RENAME.stdout}`,
    };

    expect(classifyGenerate(both)).toBe("snapshot_collision");
  });

  it("takes no sign from a line that only holds its words, a table of the list", () => {
    const listed = CLEAN_TREE.stdout.replace(
      "21 tables\n",
      "21 tables\nYour SQL migration file which is a collision created or renamed 2 columns 0 indexes 0 fks\n",
    );

    expect(classifyGenerate({ ...ended(CLEAN_TREE), output: listed })).toBe(
      "clean",
    );
  });

  it("reads a closing line printed in colours", () => {
    const coloured = CLEAN_TREE.stdout.replace(
      "No schema changes",
      "\u001b[33mNo schema changes",
    );

    expect(classifyGenerate({ ...ended(CLEAN_TREE), output: coloured })).toBe(
      "clean",
    );
  });

  it("calls a run without a closing line unfinished", () => {
    expect(classifyGenerate({ ...ended(CLEAN_TREE), output: CUT_SHORT })).toBe(
      "unfinished",
    );
  });

  it("calls a run cut at the time limit unfinished, whatever it printed", () => {
    expect(classifyGenerate({ ...ended(CLEAN_TREE), timedOut: true })).toBe(
      "unfinished",
    );
  });

  it("calls a run killed by a signal unfinished, whatever it printed", () => {
    expect(classifyGenerate({ ...ended(CLEAN_TREE), signal: "SIGKILL" })).toBe(
      "unfinished",
    );
  });

  it("calls a non-zero exit without a sign of its own unfinished", () => {
    expect(classifyGenerate({ ...ended(CLEAN_TREE), status: 1 })).toBe(
      "unfinished",
    );
  });

  it.each([
    [
      "colliding snapshots",
      "the limit",
      SNAPSHOT_COLLISION_RUN,
      { timedOut: true },
    ],
    [
      "colliding snapshots",
      "a signal",
      SNAPSHOT_COLLISION_RUN,
      { signal: "SIGTERM" },
    ],
    [
      "the question of a rename",
      "the limit",
      AMBIGUOUS_RENAME,
      { timedOut: true },
    ],
    [
      "the question of a rename",
      "a signal",
      AMBIGUOUS_RENAME,
      { signal: "SIGTERM" },
    ],
  ] as const)(
    "puts the limit and a signal before a sign: %s, cut by %s, is unfinished",
    (_what, _by, recorded, cut) => {
      expect(classifyGenerate({ ...ended(recorded), ...cut })).toBe(
        "unfinished",
      );
    },
  );

  it("reads colliding snapshots as printed on Linux, its paths with /", () => {
    expect(classifyGenerate(ended(LINUX_SNAPSHOT_COLLISION_RUN))).toBe(
      "snapshot_collision",
    );
  });

  it("reads the question of a rename as printed on Linux", () => {
    expect(classifyGenerate(ended(LINUX_AMBIGUOUS_RENAME))).toBe(
      "rename_question",
    );
  });
});

describe("classifyCheck", () => {
  const ended = (recorded: RecordedRun) => ({
    output: `${recorded.stdout}${recorded.stderr}`,
    status: recorded.status,
    signal: null,
    timedOut: false,
  });

  it("reads a consistent folder", () => {
    expect(classifyCheck(ended(CHECK_FINE))).toBe("fine");
  });

  it("reads colliding snapshots as an inconsistent folder", () => {
    expect(classifyCheck(ended(SNAPSHOT_COLLISION_CHECK))).toBe("inconsistent");
  });

  it("reads a malformed snapshot as an inconsistent folder", () => {
    expect(classifyCheck(ended(MALFORMED_SNAPSHOT_CHECK))).toBe("inconsistent");
  });

  it("calls a failure without a sign of its own - a module that would not load - unfinished", () => {
    const crashed = {
      output:
        "Error: Cannot find module './radar.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n",
      status: 1,
      signal: null,
      timedOut: false,
    };

    expect(classifyCheck(crashed)).toBe("unfinished");
  });

  it("calls an exit 0 without its closing line unfinished", () => {
    expect(
      classifyCheck({ ...ended(CHECK_FINE), output: "Reading config file\n" }),
    ).toBe("unfinished");
  });

  it("calls a run cut at the limit or killed unfinished, whatever it printed", () => {
    expect(classifyCheck({ ...ended(CHECK_FINE), timedOut: true })).toBe(
      "unfinished",
    );
    expect(classifyCheck({ ...ended(CHECK_FINE), signal: "SIGKILL" })).toBe(
      "unfinished",
    );
  });

  it.each([0, 2])(
    "calls a sign of an inconsistent folder with exit code %s, not 1, unfinished",
    (status) => {
      expect(
        classifyCheck({ ...ended(SNAPSHOT_COLLISION_CHECK), status }),
      ).toBe("unfinished");
      expect(
        classifyCheck({ ...ended(MALFORMED_SNAPSHOT_CHECK), status }),
      ).toBe("unfinished");
    },
  );
});

describe("versionOf", () => {
  it("reads the version of a package.json", () => {
    expect(versionOf('{"name":"drizzle-kit","version":"0.28.1"}')).toBe(
      "0.28.1",
    );
  });

  it("throws on a text that is not JSON", () => {
    expect(() => versionOf("{")).toThrow(SyntaxError);
  });

  it("throws on a package.json without a version", () => {
    expect(() => versionOf('{"name":"drizzle-kit"}')).toThrow(
      "its package.json holds no version",
    );
    expect(() => versionOf("[]")).toThrow("its package.json holds no version");
  });
});

describe("outOf", () => {
  it("names the copy relative to the directory drizzle-kit runs from", () => {
    expect(
      outOf(
        "/repo/packages/db",
        "/tmp/schema-drift-x/migrations",
        posix.relative,
      ),
    ).toBe("../../../tmp/schema-drift-x/migrations");
    expect(
      outOf("D:\\repo\\packages\\db", "D:\\tmp\\x\\migrations", win32.relative),
    ).toBe("..\\..\\..\\tmp\\x\\migrations");
  });

  it("has no name for a copy on another drive", () => {
    expect(
      outOf(
        "D:\\repo\\packages\\db",
        "C:\\Temp\\x\\migrations",
        win32.relative,
      ),
    ).toBeUndefined();
  });
});

describe("changesOf", () => {
  it("names each file that appeared, changed or went, by path in the order of code points", () => {
    const before = new Map([
      ["0000_core.sql", "1"],
      ["meta/_journal.json", "2"],
      ["meta/c.json", "3"],
    ]);
    const after = new Map([
      ["0000_core.sql", "1"],
      ["meta/_journal.json", "9"],
      ["meta/0001_snapshot.json", "4"],
      ["0001_d.sql", "5"],
    ]);

    expect(changesOf(before, after)).toEqual([
      "+ 0001_d.sql",
      "+ meta/0001_snapshot.json",
      "~ meta/_journal.json",
      "- meta/c.json",
    ]);
  });
});

describe("main", () => {
  it("exits with 0 on a clean tree and a consistent folder, running each once", () => {
    const result = run();

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("No schema changes, nothing to migrate");
    expect(result.out).toContain("check-schema-drift: clean");
    expect(result.runGenerate).toHaveBeenCalledTimes(1);
    expect(result.runCheck).toHaveBeenCalledTimes(1);
  });

  it("starts drizzle-kit DRIZZLE_KIT_RUNS times on its longest run, a clean one", () => {
    const result = run();

    expect(
      result.runGenerate.mock.calls.length + result.runCheck.mock.calls.length,
    ).toBe(DRIZZLE_KIT_RUNS);
  });

  it("starts generate on a temporary copy and check on the folder, from the package, stdin closed, with a time limit", () => {
    const result = run();
    const spec = result.runGenerate.mock.calls[0]?.[0];
    const copy = result.copies[0] ?? "";

    expect(spec).toEqual({
      file: process.execPath,
      args: [
        "--import",
        "tsx",
        "./node_modules/drizzle-kit/bin.cjs",
        "generate",
        "--dialect",
        "postgresql",
        "--schema",
        "./src/schema/index.ts",
        "--out",
        relative(dbDir, copy),
      ],
      cwd: dbDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DRIZZLE_KIT_TIMEOUT_MS,
    });
    expect(
      copy.startsWith(join(dbDir, "node_modules", ".cache", "schema-drift-")),
    ).toBe(true);
    expect(copy.endsWith(`${sep}migrations`)).toBe(true);
    expect(isAbsolute(spec?.args.at(-1) ?? "/")).toBe(false);
    expect(DRIZZLE_KIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(result.runCheck.mock.calls[0]?.[0]).toEqual({
      file: process.execPath,
      args: ["--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "check"],
      cwd: dbDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DRIZZLE_KIT_TIMEOUT_MS,
    });
  });

  it("runs drizzle-kit from packages/db by default", () => {
    expect(DB_DIR).toBe(join(repoRoot, "packages", "db"));
  });

  it("gives generate every value of drizzle.config.ts - the file holds no key generate would not get", () => {
    expect(drizzleConfig).toEqual(DRIZZLE_CONFIG);
  });

  it("exits with 2 when the copy has no path relative to the package, before generate runs", () => {
    const result = run({
      relativeOf: () => "C:\\Temp\\schema-drift-x\\migrations",
    });

    expect(result.code).toBe(2);
    expect(result.err).toMatch(
      /^check-schema-drift: the temporary copy .+ has no path relative to .+ \(another drive\), and drizzle-kit 0\.28\.1 reads --out relative to its working directory - the check did not take place$/,
    );
    expect(result.runGenerate).not.toHaveBeenCalled();
  });

  it("exits with 1 on a migration generate wrote, naming the files of the copy and leaving the tree as it was", () => {
    const tree = filesOf(join(dbDir, "migrations"));

    const result = run({ generate: generateLikeDrizzleKit });

    expect(result.code).toBe(1);
    for (const change of NEW_COLUMN_CHANGES) {
      expect(result.err).toContain(`  ${change}`);
    }
    expect(result.err).toContain(`check-schema-drift: ${HINTS.wrote}`);
    expect(result.err).not.toContain("delete");
    expect(result.runCheck).not.toHaveBeenCalled();
    expect(filesOf(join(dbDir, "migrations"))).toEqual(tree);
  });

  it("exits with 1 again on a second run after a red one", () => {
    const first = run({ generate: generateLikeDrizzleKit });
    const second = run({ generate: generateLikeDrizzleKit });

    expect(first.code).toBe(1);
    expect(second.code).toBe(1);
    expect(second.err).toContain("  + 0001_demonic_invisible_woman.sql");
  });

  it("exits with 0 on a migration that lies in the tree, not yet staged, and matches the schema", () => {
    writeFiles(join(dbDir, "migrations"), NEW_COLUMN_FILES);

    const result = run({ generate: generateLikeDrizzleKit });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("exits with 1 on a file of the copy generate rewrote though it said nothing changed", () => {
    const result = run({
      generate: (spec) => {
        writeFiles(copyOf(spec), { "meta/_journal.json": '{"entries":[]}\n' });
        return spawned(CLEAN_TREE);
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("  ~ meta/_journal.json");
    expect(result.err).toContain(
      `check-schema-drift: ${HINTS.changed_silently}`,
    );
    expect(result.err).not.toContain(HINTS.wrote);
  });

  it("exits with 1 on a file that appeared in the copy though generate said nothing changed", () => {
    const result = run({
      generate: (spec) => {
        writeFiles(copyOf(spec), { "0001_x.sql": "SELECT 1;\n" });
        return spawned(CLEAN_TREE);
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("  + 0001_x.sql");
    expect(result.err).toContain(
      `check-schema-drift: ${HINTS.changed_silently}`,
    );
  });

  it("exits with 1 on a migration generate says it wrote though the copy did not change, with the hint alone", () => {
    const result = run({ generate: spawned(NEW_COLUMN) });

    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.wrote}`);
  });

  it("exits with 1 on the question of an ambiguous rename, with its hint", () => {
    const result = run({ generate: spawned(AMBIGUOUS_RENAME) });

    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.rename_question}`);
    expect(result.out).toContain("created or renamed");
    expect(result.runCheck).not.toHaveBeenCalled();
  });

  it("reads a sign of stderr that follows a last line of stdout without its newline", () => {
    const result = run({
      generate: {
        status: 0,
        signal: null,
        stdout: AMBIGUOUS_RENAME.stdout,
        stderr: SNAPSHOT_COLLISION_RUN.stdout,
      },
    });

    expect(AMBIGUOUS_RENAME.stdout.endsWith("\n")).toBe(false);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.snapshot_collision}`);
  });

  it("reads the closing line of check on stderr after a last line of stdout without its newline", () => {
    const at = CHECK_FINE.stdout.indexOf("\nEverything's fine");
    const result = run({
      check: {
        status: 0,
        signal: null,
        stdout: CHECK_FINE.stdout.slice(0, at),
        stderr: CHECK_FINE.stdout.slice(at + 1),
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("exits with 1 on colliding snapshots, with its hint", () => {
    const result = run({ generate: spawned(SNAPSHOT_COLLISION_RUN) });

    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.snapshot_collision}`);
  });

  it("removes the copy after a clean run, a red one and one that did not take place", () => {
    const runs = [
      run(),
      run({ generate: generateLikeDrizzleKit }),
      run({ generate: failedSpawn("ETIMEDOUT") }),
    ];

    expect(runs.map((one) => one.code)).toEqual([0, 1, 2]);
    for (const one of runs) {
      const copy = one.copies[0] ?? "";
      expect(copy).not.toBe("");
      expect(existsSync(dirname(copy))).toBe(false);
    }
  });

  it("exits with 2 on a generate without its closing line", () => {
    const result = run({
      generate: { status: 0, signal: null, stdout: CUT_SHORT, stderr: "" },
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      `check-schema-drift: none of its closing lines printed\n${HINTS.unfinished}`,
    );
    expect(result.runCheck).not.toHaveBeenCalled();
  });

  it("exits with 2 on a generate stopped at the time limit", () => {
    const result = run({ generate: failedSpawn("ETIMEDOUT") });

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `stopped at the limit of ${DRIZZLE_KIT_TIMEOUT_MS} ms`,
    );
  });

  it("exits with 2 on a generate killed by a signal", () => {
    const result = run({
      generate: { ...spawned(CLEAN_TREE), status: null, signal: "SIGKILL" },
    });

    expect(result.code).toBe(2);
    expect(result.err).toContain("killed by SIGKILL");
  });

  it("exits with 2 on a generate that failed without a sign of its own, naming its exit code", () => {
    const result = run({
      generate: { status: 1, signal: null, stdout: "", stderr: "TypeError" },
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      `check-schema-drift: exit code 1\n${HINTS.unfinished}`,
    );
  });

  it("exits with 2 when drizzle-kit cannot be started", () => {
    const result = run({ generate: failedSpawn("ENOENT") });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      "check-schema-drift: cannot start drizzle-kit generate: spawnSync node ENOENT",
    );
  });

  it("exits with 2 on a generate that printed more than the buffer holds, saying so", () => {
    const result = run({ generate: failedSpawn("ENOBUFS") });

    expect(result.code).toBe(2);
    expect(result.err).toMatch(
      /^check-schema-drift: drizzle-kit generate printed more than \d+ bytes - the check did not take place$/,
    );
  });

  it("exits with 1 on a check that finds colliding snapshots after a clean generate", () => {
    const result = run({ check: spawned(SNAPSHOT_COLLISION_CHECK) });

    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.check_failed}`);
    expect(result.out).toContain("which is a collision");
  });

  it("exits with 1 on a check that finds a malformed snapshot", () => {
    const result = run({ check: spawned(MALFORMED_SNAPSHOT_CHECK) });

    expect(result.code).toBe(1);
    expect(result.err).toBe(`check-schema-drift: ${HINTS.check_failed}`);
  });

  it("exits with 2 on a check that failed without a sign of its own", () => {
    const result = run({
      check: { status: 1, signal: null, stdout: "", stderr: "Error: boom" },
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      `check-schema-drift: drizzle-kit check: exit code 1\n${HINTS.check_unfinished}`,
    );
  });

  it("exits with 2 when check cannot be started", () => {
    const result = run({ check: failedSpawn("ENOENT") });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      "check-schema-drift: cannot start drizzle-kit check: spawnSync node ENOENT",
    );
  });

  it("exits with 2 when check is stopped at the limit", () => {
    const result = run({ check: failedSpawn("ETIMEDOUT") });

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `drizzle-kit check: stopped at the limit of ${DRIZZLE_KIT_TIMEOUT_MS} ms`,
    );
  });

  it("exits with 2 when check is killed by a signal", () => {
    const result = run({
      check: { ...spawned(CHECK_FINE), status: null, signal: "SIGKILL" },
    });

    expect(result.code).toBe(2);
    expect(result.err).toContain("drizzle-kit check: killed by SIGKILL");
  });

  it("exits with 2 when the copy cannot be read after generate", () => {
    const result = run({
      generate: (spec) => {
        rmSync(copyOf(spec), { recursive: true, force: true });
        return spawned(CLEAN_TREE);
      },
    });

    expect(result.code).toBe(2);
    expect(result.err).toMatch(
      /^check-schema-drift: cannot read the copy .+migrations: ENOENT/,
    );
    expect(result.runCheck).not.toHaveBeenCalled();
  });

  it("names a copy it cannot remove and keeps the verdict of the run", () => {
    const result = run({
      removeDir: (dir) => {
        throw new Error(`EBUSY: resource busy, rmdir '${dir}'`);
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toMatch(
      /^check-schema-drift: cannot remove the temporary copy .+schema-drift-\w+: EBUSY/,
    );
  });

  it("removes copies left behind longer ago than STALE_COPY_MS, not a younger one of a run going on next to it", () => {
    const parent = join(dbDir, "node_modules", ".cache");
    const at = Date.now();
    const old = join(parent, "schema-drift-old");
    const young = join(parent, "schema-drift-young");
    const other = join(parent, "other-old");
    for (const dir of [old, young, other]) {
      writeFiles(dir, { "migrations/0000_core.sql": "SELECT 1;\n" });
    }
    const aged = (at - STALE_COPY_MS - 60_000) / 1000;
    utimesSync(old, aged, aged);
    utimesSync(other, aged, aged);
    const nearly = (at - STALE_COPY_MS + 60_000) / 1000;
    utimesSync(young, nearly, nearly);

    const result = run({ now: () => at });

    expect(result.code).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("names a copy left behind it cannot remove and goes on", () => {
    const parent = join(dbDir, "node_modules", ".cache");
    const old = join(parent, "schema-drift-old");
    writeFiles(old, { "migrations/0000_core.sql": "SELECT 1;\n" });

    const result = run({
      now: () => Date.now() + 2 * STALE_COPY_MS,
      removeDir: (dir) => {
        if (dir === old) throw new Error("EPERM: operation not permitted");
        rmSync(dir, { recursive: true, force: true });
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toBe(
      `check-schema-drift: cannot remove the copy left behind ${old}: EPERM: operation not permitted`,
    );
  });

  it("passes over a copy left behind that another run removed in between, saying nothing", () => {
    const parent = join(dbDir, "node_modules", ".cache");
    const old = join(parent, "schema-drift-old");
    writeFiles(old, { "migrations/0000_core.sql": "SELECT 1;\n" });

    const result = run({
      now: () => Date.now() + 2 * STALE_COPY_MS,
      removeDir: (dir) => {
        rmSync(dir, { recursive: true, force: true });
        if (dir === old) {
          throw Object.assign(
            new Error(`ENOENT: no such file, rmdir '${dir}'`),
            {
              code: "ENOENT",
            },
          );
        }
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("names a folder of copies it cannot list and goes on with the run", async () => {
    const parent = join(dbDir, "node_modules", ".cache");
    const denied = `EACCES: permission denied, scandir '${parent}'`;
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof Fs>();
      return {
        ...fs,
        readdirSync: (...args: unknown[]): unknown => {
          if (args[0] === parent) {
            throw Object.assign(new Error(denied), { code: "EACCES" });
          }
          return Reflect.apply(fs.readdirSync, fs, args);
        },
      };
    });
    try {
      const script = await import("../scripts/check-schema-drift.mjs");
      const err: string[] = [];

      const code = script.main([], {
        runGenerate: () => spawned(CLEAN_TREE),
        runCheck: () => spawned(CHECK_FINE),
        readVersion: () => DRIZZLE_KIT_VERSION,
        dbDir,
        out: () => undefined,
        err: (line) => err.push(line),
      });

      expect(code).toBe(0);
      expect(err).toEqual([
        `check-schema-drift: cannot list the copies left behind in ${parent}: ${denied}`,
      ]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("exits with 2 when the folder cannot be copied", () => {
    rmSync(join(dbDir, "migrations"), { recursive: true, force: true });

    const result = run();

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `check-schema-drift: cannot copy the migrations folder of ${dbDir}:`,
    );
    expect(result.runGenerate).not.toHaveBeenCalled();
  });

  it("makes the copy under node_modules/.cache of the package, creating it, not in the temporary directory of the system", () => {
    const result = run();
    const copy = result.copies[0] ?? "";

    expect(result.code).toBe(0);
    expect(dirname(dirname(copy))).toBe(join(dbDir, "node_modules", ".cache"));
    expect(existsSync(join(dbDir, "node_modules", ".cache"))).toBe(true);
    expect(existsSync(dirname(copy))).toBe(false);
  });

  it("exits with 2 when no temporary directory can be made", () => {
    const blocked = join(dbDir, "blocked");
    writeFileSync(blocked, "");
    const result = run({ tempRoot: blocked });

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      "check-schema-drift: cannot make a temporary directory in",
    );
    expect(result.runGenerate).not.toHaveBeenCalled();
  });

  it("exits with 2 on another installed version of drizzle-kit, before it runs", () => {
    const result = run({ version: "0.28.2" });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      "check-schema-drift: drizzle-kit 0.28.2 is installed, the signs of its output are recorded for 0.28.1 - record test/schema-drift-fixture.ts again from the new version, check the signs of scripts/check-schema-drift.mjs against it and set DRIZZLE_KIT_VERSION",
    );
    expect(result.runGenerate).not.toHaveBeenCalled();
  });

  it("exits with 2 when drizzle-kit is not installed", () => {
    const gone = Object.assign(new Error("no file"), { code: "ENOENT" });

    const result = run({ version: gone });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      "check-schema-drift: drizzle-kit is not installed in packages/db - run pnpm install",
    );
  });

  it("exits with 2 when the version of drizzle-kit cannot be read", () => {
    const result = run({
      version: new Error("its package.json holds no version"),
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      "check-schema-drift: cannot read the version of drizzle-kit: its package.json holds no version",
    );
  });

  it("exits with 2 on an argument", () => {
    expect(main(["--fix"], { err: () => undefined })).toBe(2);
  });
});

describe("runEntry", () => {
  it("runs nothing when the module is not the entry", () => {
    const runGenerate = vi.fn<Spawn>();

    expect(runEntry(() => false, [], { runGenerate })).toBeUndefined();
    expect(runGenerate).not.toHaveBeenCalled();
  });

  it("gives the exit code of main on the entry", () => {
    const err: string[] = [];

    expect(
      runEntry(() => true, ["--fix"], { err: (line) => err.push(line) }),
    ).toBe(2);
    expect(err).toEqual(["check-schema-drift: takes no arguments, got --fix"]);
  });

  it("exits with 2, not the 1 of drift, on a throw out of main, saying so", () => {
    const err: string[] = [];

    const code = runEntry(() => true, [], {
      readVersion: () => DRIZZLE_KIT_VERSION,
      dbDir,
      runGenerate: () => spawned(CLEAN_TREE),
      runCheck: () => spawned(CHECK_FINE),
      out: () => {
        throw new Error("write EPIPE");
      },
      err: (line) => err.push(line),
    });

    expect(code).toBe(2);
    expect(err).toEqual([
      "check-schema-drift: the check did not take place: write EPIPE",
    ]);
  });

  it("exits with 2 on a throw of the guard of the entry", () => {
    const err: string[] = [];

    const code = runEntry(
      () => {
        throw new Error("cannot stat scripts/check-schema-drift.mjs");
      },
      [],
      { err: (line) => err.push(line) },
    );

    expect(code).toBe(2);
    expect(err).toEqual([
      "check-schema-drift: the check did not take place: cannot stat scripts/check-schema-drift.mjs",
    ]);
  });

  it("exits with 2 even when the line that says why cannot be printed", () => {
    const code = runEntry(
      () => {
        throw new Error("boom");
      },
      [],
      {
        err: () => {
          throw new Error("write EPIPE");
        },
      },
    );

    expect(code).toBe(2);
  });
});

/**
 * The gate `schema-drift` of .claude/hooks/rules.sf.json: chosen on every
 * file the script reads and on nothing else (L-018), and with a limit above
 * the longest run of the script, so the script, not the hook, says why a run
 * stopped.
 */
describe("the schema-drift gate", () => {
  /** The gate, read when a case asks for it, never on the collection. */
  const gate = () => gateOf("schema-drift");

  /** What a gate runs and its limit, which only these cases read. */
  const RunSchema = z
    .object({ cmd: z.string(), timeoutSec: z.number() })
    .passthrough();
  const runOf = () => RunSchema.parse(gate());

  it("runs the script as CI runs it", () => {
    expect(runOf().cmd).toBe("node scripts/check-schema-drift.mjs");
  });

  it("has a limit above the runs of drizzle-kit the script makes, with room to copy and compare", () => {
    expect(runOf().timeoutSec * 1000).toBeGreaterThanOrEqual(
      DRIZZLE_KIT_RUNS * DRIZZLE_KIT_TIMEOUT_MS + 30_000,
    );
  });

  it("ends before a copy of a run counts as left behind", () => {
    expect(STALE_COPY_MS).toBeGreaterThan(runOf().timeoutSec * 1000);
  });

  it.each([
    "packages/db/src/schema/system.ts",
    "packages/db/src/schema/index.ts",
    "packages/db/migrations/0000_core.sql",
    "packages/db/migrations/meta/_journal.json",
    "packages/db/migrations/meta/0000_snapshot.json",
    "packages/db/drizzle.config.ts",
    "packages/db/package.json",
    "packages/db/tsconfig.json",
    "tsconfig.base.json",
    "pnpm-lock.yaml",
    "scripts/check-schema-drift.mjs",
    "scripts/lib/files.mjs",
    "scripts/lib/json.mjs",
    "scripts/lib/paths.mjs",
  ])("is chosen on %s", (file) => {
    expect(chosenOn(gate(), file)).toBe(true);
  });

  it.each([
    "packages/db/src/repos/x.ts",
    "packages/db/src/migrate.ts",
    "packages/db/src/migration-lock.ts",
    "packages/db/test/tsconfig.json",
    "tsconfig.json",
    "scripts/check-compose.mjs",
    "scripts/lib/yaml-doc.mjs",
  ])("is not chosen on %s", (file) => {
    expect(chosenOn(gate(), file)).toBe(false);
  });
});

describe("gateOf", () => {
  it("reads a gate of only an id and a when, next to gates of their own shape", () => {
    const rules = {
      gates: [
        { id: "other", cmd: "node x.mjs", when: "x/**", timeoutSec: 30 },
        { id: "bare", when: "y/**" },
      ],
    };

    expect(gateOf("bare", rules)).toEqual({ id: "bare", when: "y/**" });
    expect(chosenOn(gateOf("bare", rules), "y/z.ts")).toBe(true);
  });
});

describe("spawnDrizzleKit", () => {
  const specOf = (code: string, timeout = 30_000) => ({
    file: process.execPath,
    args: ["-e", code],
    cwd: dbDir,
    stdio: ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"],
    timeout,
  });

  it("gives the exit code and stdout and stderr apart, as text, without an error on a run that ended by itself", () => {
    expect(
      spawnDrizzleKit(
        specOf(
          'process.stdout.write("out \u2713\\n"); process.stderr.write("err"); process.exit(3)',
        ),
      ),
    ).toEqual({
      status: 3,
      signal: null,
      stdout: "out \u2713\n",
      stderr: "err",
    });
  });

  it("runs from the cwd of its spec, stdin closed", () => {
    const result = spawnDrizzleKit(
      specOf(
        'process.stdout.write(process.cwd() + "|" + require("node:fs").readFileSync(0, "utf8"))',
      ),
    );
    const [cwd, stdin] = result.stdout.split("|");

    expect(result.status).toBe(0);
    expect(realpathSync(cwd ?? "")).toBe(realpathSync(dbDir));
    expect(stdin).toBe("");
  });

  it("gives the error of a run stopped at its limit", () => {
    const result = spawnDrizzleKit(specOf("setTimeout(() => {}, 30000)", 500));

    expect(timedOut(result)).toBe(true);
    expect(result.status).toBeNull();
  });

  it("gives the error of a binary that cannot start, with empty outputs", () => {
    const result = spawnDrizzleKit({
      ...specOf(""),
      file: join(dbDir, "no-such-node"),
    });

    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({ status: null, stdout: "", stderr: "" });
  });
});

describe("installedVersion", () => {
  it("reads the version of the drizzle-kit packages/db resolves", () => {
    expect(installedVersion()).toBe(DRIZZLE_KIT_VERSION);
  });
});

describe("filesOf", () => {
  it("lists every file under the folder, nested ones by their path from it", () => {
    const files = filesOf(join(dbDir, "migrations"));

    expect([...files.keys()].sort()).toEqual(Object.keys(COMMITTED).sort());
  });
});
