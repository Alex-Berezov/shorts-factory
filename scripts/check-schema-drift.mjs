#!/usr/bin/env node
/**
 * Gate: a change of the schema of `@sf/db` (packages/db/src/schema) without
 * the migration it needs. The rules live here, CI runs this script as its one
 * step of the schema drift, and the gate hook runs it on a change of what the
 * script reads (.claude/hooks/rules.sf.json, gate `schema-drift`).
 *
 * The order of a run:
 * 1. the installed drizzle-kit must be `DRIZZLE_KIT_VERSION`, the version the
 *    signs below were recorded with (test/schema-drift-fixture.ts) - on any
 *    other the check does not take place: a sign it no longer prints would
 *    read as a clean tree;
 * 2. packages/db/migrations, as it lies on disk - a migration not yet
 *    committed included - is copied into a temporary directory under
 *    `COPY_PARENT` of packages/db, and `drizzle-kit generate` writes into
 *    the copy, never into the tree: a red run leaves nothing behind that the
 *    next run, or a commit, would take for the migration of the schema. A
 *    copy older than `STALE_COPY_MS` - left by a run killed from outside,
 *    where its `finally` did not run - is removed first; a younger one may
 *    belong to a run going on next to this one and stays;
 * 3. its output is printed as it is, then classified (`classifyGenerate`).
 *    Generate exits with 0 in two cases that are drift: an ambiguous rename,
 *    where it asks "created or renamed" and, with stdin closed, gives up
 *    having written nothing; and two snapshots pointing to one parent (two
 *    branches that each added a migration), which it prints as a collision.
 *    Both are told by its output, and so is a generate that stopped before it
 *    said it finished;
 * 4. the files of the copy are compared with what was copied, by path and by
 *    content: any file generate added, changed or removed is drift, whatever
 *    it printed;
 * 5. `drizzle-kit check` on the folder itself, through drizzle.config.ts, the
 *    second line: the folder must be consistent (`classifyCheck`).
 *
 * drizzle-kit is started the way `db:generate` and `db:check` of
 * packages/db/package.json start it - its binary (`DRIZZLE_KIT_BIN`) with
 * the loader of tsx, both held to those scripts by test/ci-config.test.ts
 * (`drizzleKitSpec`) - but in one process: this node with `--import tsx`,
 * not the CLI of tsx, which starts a second node of its own. From
 * packages/db, without a shell, with stdin closed and a time limit: the limit
 * kills the very process that runs drizzle-kit. Generate gets the three values of
 * drizzle.config.ts on its command line (`DRIZZLE_CONFIG`, held equal to the
 * file by the unit): 0.28.1 refuses `--config` next to `--out`, and reads
 * `--out` relative to its working directory, so the copy is named by a
 * relative path from packages/db: the copy is made under
 * packages/db/node_modules/.cache (`COPY_PARENT`), on the drive of the
 * package and outside what git sees, not in the temporary directory of the
 * system, which may lie on another drive; a copy on another drive has no
 * relative path, and the check does not take place. With stdin closed
 * generate does not wait at its question, so the limit is a safeguard, not
 * the way a run ends.
 *
 * Usage: `node scripts/check-schema-drift.mjs`.
 * Exit 0 when the migrations match the schema; 1 on drift (a migration
 * generate would write, a rename it asks about, colliding snapshots, a
 * folder check finds inconsistent), with a hint on stderr; 2 when the check
 * did not take place (a failed start, the time limit, an output not
 * recognised, a copy that cannot be made, another version of drizzle-kit,
 * anything the run throws).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, win32 } from "node:path";
import { codeOf, isGone, messageOf, timedOut } from "./lib/files.mjs";
import { isRecord } from "./lib/json.mjs";
import { isEntry, repoRoot } from "./lib/paths.mjs";

/** The version of drizzle-kit the signs of its output were recorded with. */
export const DRIZZLE_KIT_VERSION = "0.28.1";

/** The package of the schema; drizzle-kit runs from it. */
export const DB_DIR = join(repoRoot, "packages/db");

/**
 * Where, under the package drizzle-kit runs from, the copy of the folder is
 * made: on its drive, ignored by git (node_modules), created when missing.
 */
const COPY_PARENT = join("node_modules", ".cache");

/** The prefix of the name of every copy under `COPY_PARENT`. */
const COPY_PREFIX = "schema-drift-";

/**
 * How old a copy under `COPY_PARENT` is before a run removes it as left
 * behind: far above `timeoutSec` of the gate and the limit of the step of
 * CI, the longest a run goes on (both held by the units), so the copy of a
 * run going on next to this one is never taken.
 */
export const STALE_COPY_MS = 30 * 60_000;

/**
 * Every value of packages/db/drizzle.config.ts, the ones generate gets on its
 * command line in place of the file; `out` is the folder that is copied. The
 * unit holds the file equal to this object, so a key added there - one
 * generate here would not get - turns it red.
 */
export const DRIZZLE_CONFIG = /** @type {const} */ ({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});

/**
 * The loader of tsx, resolved from packages/db, and the binary of
 * drizzle-kit: the bypass of `db:generate` and `db:check`
 * (`tsx ./node_modules/drizzle-kit/bin.cjs`).
 */
const TSX = "tsx";
export const DRIZZLE_KIT_BIN = "./node_modules/drizzle-kit/bin.cjs";

/**
 * The limit of one run of drizzle-kit: three times the cold run measured on
 * the development machine (7.6 s, warm 1.5-2.5 s, 22.10.2026) is below the
 * floor of 60 s, so the floor. A run of the script starts drizzle-kit twice,
 * so it ends within twice this limit and the time to copy and compare the
 * folder; `timeoutSec` of the gate is above that, so the script, not the
 * hook, names why a run stopped.
 */
export const DRIZZLE_KIT_TIMEOUT_MS = 60_000;

/**
 * How many runs of drizzle-kit one run of the script makes, at most; the
 * unit counts them on the longest run, a clean one.
 */
export const DRIZZLE_KIT_RUNS = 2;

/** Room for the output of drizzle-kit. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** An escape sequence of the terminal (`ESC [ ... letter`). */
const TERMINAL_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
  "g",
);

/**
 * The signs of the output of drizzle-kit, each read against one whole line,
 * its escapes of the terminal removed - a name of a table or a column that
 * holds the words of a sign is not a sign. Only the ASCII part of a line is
 * matched, so a console that is not UTF-8 does not hide them. The only place
 * the lines of drizzle-kit live.
 */
const SIGNS = {
  /** The closing line of a generate that found nothing to do. */
  clean: /^No schema changes, nothing to migrate\b/,
  /** The closing line of a generate that wrote a migration. */
  wrote: /^\[[^\]]*\] Your SQL migration file /,
  /** The question of an ambiguous rename of a column or a table. */
  renameQuestion: /^Is .+ created or renamed from another \S+\?$/,
  /** Two snapshots that point to one parent, of generate and of check. */
  collision:
    /^(?:Error: )?\[.+\] are pointing to a parent snapshot: .+ which is a collision\.$/,
  /** A snapshot check cannot read. */
  malformed: /^\S.* data is malformed$/,
  /** The closing line of a check that found the folder consistent. */
  fine: /^Everything's fine\b/,
};

/**
 * Whether a sign is one whole line of `output`, each line read without the
 * escapes of the terminal.
 *
 * @param {string} output
 * @returns {(sign: RegExp) => boolean}
 */
function signsIn(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(TERMINAL_ESCAPE, ""));
  return (sign) => lines.some((line) => sign.test(line));
}

/**
 * What a run of generate came to.
 *
 * @typedef {"clean" | "wrote" | "rename_question" | "snapshot_collision" | "unfinished"} GenerateOutcome
 */

/**
 * A run of drizzle-kit as the classifiers read it.
 *
 * @typedef {object} EndedRun
 * @property {string} output stdout, then stderr from a line of its own
 * @property {number | null} status
 * @property {string | null} signal
 * @property {boolean} timedOut
 */

/**
 * What generate came to, from its output and how it ended. A run cut by the
 * limit or a signal is `unfinished` whatever it printed; a sign of a
 * collision wins over one of a rename, and both win over the exit code
 * (generate exits with 0 on both); a non-zero code without one of them is
 * `unfinished`, and so is a run that did not print one of its closing lines.
 *
 * @param {EndedRun} run
 * @returns {GenerateOutcome}
 */
export function classifyGenerate({ output, status, signal, timedOut }) {
  if (timedOut || signal !== null) return "unfinished";
  const has = signsIn(output);
  if (has(SIGNS.collision)) return "snapshot_collision";
  if (has(SIGNS.renameQuestion)) return "rename_question";
  if (status !== 0) return "unfinished";
  if (has(SIGNS.wrote)) return "wrote";
  if (has(SIGNS.clean)) return "clean";
  return "unfinished";
}

/**
 * What check came to: the folder is consistent (exit 0 and its closing
 * line), inconsistent (exit 1 with a collision or a malformed snapshot), or
 * the check did not take place - a limit, a signal, or any other ending, a
 * module that would not load among them.
 *
 * @param {EndedRun} run
 * @returns {"fine" | "inconsistent" | "unfinished"}
 */
export function classifyCheck({ output, status, signal, timedOut }) {
  if (timedOut || signal !== null) return "unfinished";
  const has = signsIn(output);
  if (status === 0 && has(SIGNS.fine)) return "fine";
  if (status === 1 && (has(SIGNS.collision) || has(SIGNS.malformed))) {
    return "inconsistent";
  }
  return "unfinished";
}

/** The command a hint sends the developer to. */
const GENERATE_COMMAND = "pnpm db:generate --name <epic>";

/**
 * The hint of each refusal, after its first line.
 *
 * @type {Record<"wrote" | "changed_silently" | "rename_question" | "snapshot_collision" | "unfinished" | "check_failed" | "check_unfinished", string>}
 */
export const HINTS = {
  wrote: `the schema changed without its migration: run ${GENERATE_COMMAND}, then commit the migration`,
  changed_silently: `drizzle-kit generate said there were no schema changes, yet changed the copy of the migrations folder (listed above) - the folder is not what generate keeps: run ${GENERATE_COMMAND}, look at what it changes in packages/db/migrations and commit it`,
  rename_question: `drizzle-kit generate asks whether a column or a table was created or renamed: run ${GENERATE_COMMAND} locally, answer it and commit the migration`,
  snapshot_collision: `two migrations point to the same parent snapshot - two branches each added one: rebase on main, delete the migration of this branch and run ${GENERATE_COMMAND} again, then commit it`,
  unfinished:
    "drizzle-kit generate did not finish - the check did not take place: run it from packages/db and read its output above",
  check_failed: `drizzle-kit check finds the migrations folder inconsistent (output above): fix the folder - after a rebase, regenerate the migration of this branch with ${GENERATE_COMMAND}`,
  check_unfinished:
    "drizzle-kit check did not finish - the check did not take place: run pnpm db:check from packages/db and read its output above",
};

/**
 * How `main` starts drizzle-kit.
 *
 * @typedef {object} SpawnSpec
 * @property {string} file
 * @property {string[]} args
 * @property {string} cwd
 * @property {["ignore", "pipe", "pipe"]} stdio
 * @property {number} timeout
 */

/**
 * What a run of drizzle-kit gave, as `spawnSync` gives it.
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error} [error]
 */

/**
 * What `main` works with; each has a default that reaches drizzle-kit, the
 * disk and the console.
 *
 * @typedef {object} DriftDeps
 * @property {(spec: SpawnSpec) => SpawnResult} [runGenerate]
 * @property {(spec: SpawnSpec) => SpawnResult} [runCheck]
 * @property {() => string} [readVersion] the version of the drizzle-kit
 *   packages/db resolves; throws when it cannot be read
 * @property {string} [dbDir] the package drizzle-kit runs from, `DB_DIR`
 * @property {string} [tempRoot] where the copy of the folder is made,
 *   `COPY_PARENT` of `dbDir`; created when missing
 * @property {(from: string, to: string) => string} [relativeOf] the path
 *   from `dbDir` to the copy, `path.relative`
 * @property {(dir: string) => void} [removeDir] removes a copy and all it
 *   holds
 * @property {() => number} [now] the time, in ms, the age of a copy is read
 *   against
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/**
 * The run of drizzle-kit with `args` after its binary, from `cwd`: one
 * node, the loader of tsx imported into it.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {SpawnSpec}
 */
export function drizzleKitSpec(cwd, args) {
  return {
    file: process.execPath,
    args: ["--import", TSX, DRIZZLE_KIT_BIN, ...args],
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DRIZZLE_KIT_TIMEOUT_MS,
  };
}

/**
 * Runs `spec` as `spawnSync` does, its output as text; the default of
 * `runGenerate` and `runCheck`.
 *
 * @param {SpawnSpec} spec
 * @returns {SpawnResult}
 */
export function spawnDrizzleKit(spec) {
  const result = spawnSync(spec.file, spec.args, {
    cwd: spec.cwd,
    stdio: spec.stdio,
    timeout: spec.timeout,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * The version of a `package.json` of drizzle-kit, from its text; throws when
 * the text is not JSON or holds no version.
 *
 * @param {string} text
 * @returns {string}
 */
export function versionOf(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("its package.json holds no version");
  }
  return parsed.version;
}

/**
 * The version of the drizzle-kit packages/db resolves.
 *
 * @returns {string}
 */
export function installedVersion() {
  return versionOf(
    readFileSync(
      join(DB_DIR, "node_modules", "drizzle-kit", "package.json"),
      "utf8",
    ),
  );
}

/**
 * Every file under `dir`, by its path from `dir` (`/`-separated), with the
 * sha256 of its content.
 *
 * @param {string} dir
 * @returns {Map<string, string>}
 */
export function filesOf(dir) {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @param {string} at @param {string} prefix */
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${name}/`);
      else {
        files.set(
          name,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
    }
  };
  walk(dir, "");
  return files;
}

/**
 * What changed between two listings of `filesOf`: `+ path` for a file that
 * appeared, `~ path` for one whose content changed, `- path` for one that
 * went, by path (by code point, the same order on any locale).
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]}
 */
export function changesOf(before, after) {
  /** @type {string[]} */
  const changes = [];
  for (const [path, hash] of after) {
    const was = before.get(path);
    if (was === undefined) changes.push(`+ ${path}`);
    else if (was !== hash) changes.push(`~ ${path}`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`- ${path}`);
  }
  const pathOf = (/** @type {string} */ change) => change.slice(2);
  return changes.sort((a, b) =>
    pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0,
  );
}

/**
 * The path `--out` names the copy by: relative to the directory drizzle-kit
 * runs from, which it joins `--out` to; undefined when there is none - the
 * copy lies on another drive, and the path that came back is absolute. It is
 * read by the rules of Windows, which take `/`, `\` and `C:\` for the start
 * of an absolute path, so the answer is the same on any platform.
 *
 * @param {string} cwd
 * @param {string} copy
 * @param {(from: string, to: string) => string} [relativeOf]
 * @returns {string | undefined}
 */
export function outOf(cwd, copy, relativeOf = relative) {
  const path = relativeOf(cwd, copy);
  return win32.isAbsolute(path) ? undefined : path;
}

/** The prefix of every line of the script. */
const NAME = "check-schema-drift";

/**
 * Why a run of drizzle-kit `command` failed as a process - it could not
 * start, or printed more than the buffer holds - or undefined when it ran
 * (the time limit included: that is a run that did not finish).
 *
 * @param {SpawnResult} run
 * @param {"generate" | "check"} command
 * @returns {string | undefined}
 */
function spawnFailure(run, command) {
  if (run.error === undefined || timedOut(run)) return undefined;
  if (codeOf(run.error) === "ENOBUFS") {
    return `drizzle-kit ${command} printed more than ${MAX_BUFFER} bytes - the check did not take place`;
  }
  return `cannot start drizzle-kit ${command}: ${messageOf(run.error)}`;
}

/**
 * Why a run of drizzle-kit did not finish, for the refusal.
 *
 * @param {SpawnResult} run
 * @returns {string}
 */
function unfinishedWhy(run) {
  if (timedOut(run)) {
    return `stopped at the limit of ${DRIZZLE_KIT_TIMEOUT_MS} ms`;
  }
  if (run.signal !== null) return `killed by ${run.signal}`;
  if (run.status !== 0) return `exit code ${run.status}`;
  return "none of its closing lines printed";
}

/**
 * The run as the classifiers read it. stderr starts on a line of its own:
 * the last line of stdout may lack its `\n` (the menu of the question of a
 * rename does), and glued to the first line of stderr neither would be read
 * as a whole line.
 *
 * @param {SpawnResult} run
 * @returns {EndedRun}
 */
function ended(run) {
  const joint =
    run.stdout === "" || run.stderr === "" || run.stdout.endsWith("\n")
      ? ""
      : "\n";
  return {
    output: `${run.stdout}${joint}${run.stderr}`,
    status: run.status,
    signal: run.signal,
    timedOut: timedOut(run),
  };
}

/**
 * Generate into a copy of the folder; the exit code of a run that ends here,
 * or undefined when generate found the folder matching the schema.
 *
 * @param {Required<Pick<DriftDeps, "runGenerate" | "relativeOf" | "out" | "err">>} io
 * @param {string} dbDir
 * @param {string} copy the temporary directory the folder is copied into
 * @returns {number | undefined}
 */
function generateInCopy({ runGenerate, relativeOf, out, err }, dbDir, copy) {
  const target = join(copy, "migrations");
  const outArg = outOf(dbDir, target, relativeOf);
  if (outArg === undefined) {
    err(
      `${NAME}: the temporary copy ${target} has no path relative to ${dbDir} (another drive), and drizzle-kit ${DRIZZLE_KIT_VERSION} reads --out relative to its working directory - the check did not take place`,
    );
    return 2;
  }
  /** @type {Map<string, string>} */
  let before;
  try {
    cpSync(join(dbDir, DRIZZLE_CONFIG.out), target, { recursive: true });
    before = filesOf(target);
  } catch (error) {
    err(
      `${NAME}: cannot copy the migrations folder of ${dbDir}: ${messageOf(error)}`,
    );
    return 2;
  }

  const generate = runGenerate(
    drizzleKitSpec(dbDir, [
      "generate",
      "--dialect",
      DRIZZLE_CONFIG.dialect,
      "--schema",
      DRIZZLE_CONFIG.schema,
      "--out",
      outArg,
    ]),
  );
  const run = ended(generate);
  if (run.output.trim() !== "") out(run.output.trimEnd());
  const failure = spawnFailure(generate, "generate");
  if (failure !== undefined) {
    err(`${NAME}: ${failure}`);
    return 2;
  }
  const outcome = classifyGenerate(run);
  if (outcome === "unfinished") {
    err(`${NAME}: ${unfinishedWhy(generate)}`);
    err(HINTS.unfinished);
    return 2;
  }

  /** @type {string[]} */
  let changes;
  try {
    changes = changesOf(before, filesOf(target));
  } catch (error) {
    err(`${NAME}: cannot read the copy ${target}: ${messageOf(error)}`);
    return 2;
  }
  if (outcome === "clean" && changes.length === 0) return undefined;
  if (changes.length > 0) {
    err(
      `${NAME}: generate changed the copy of the migrations folder (the tree is untouched):`,
    );
    for (const change of changes) err(`  ${change}`);
  }
  err(`${NAME}: ${HINTS[outcome === "clean" ? "changed_silently" : outcome]}`);
  return 1;
}

/**
 * Removes each copy under `tempRoot` older than `STALE_COPY_MS`, by the
 * time it was last written. A copy gone in between - another run removed
 * it - is no failure; any other, and a `tempRoot` that cannot be listed, is
 * named and the run goes on: a copy left behind takes room, not the verdict.
 *
 * @param {string} tempRoot
 * @param {Required<Pick<DriftDeps, "removeDir" | "now" | "err">>} io
 */
function removeStaleCopies(tempRoot, { removeDir, now, err }) {
  const at = now();
  let entries;
  try {
    entries = readdirSync(tempRoot, { withFileTypes: true });
  } catch (error) {
    err(
      `${NAME}: cannot list the copies left behind in ${tempRoot}: ${messageOf(error)}`,
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(COPY_PREFIX)) continue;
    const dir = join(tempRoot, entry.name);
    try {
      if (at - statSync(dir).mtimeMs > STALE_COPY_MS) removeDir(dir);
    } catch (error) {
      if (!isGone(error)) {
        err(
          `${NAME}: cannot remove the copy left behind ${dir}: ${messageOf(error)}`,
        );
      }
    }
  }
}

/**
 * Removes a directory and all it holds.
 *
 * @param {string} dir
 */
function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs the check; returns the exit code.
 *
 * @param {string[]} argv the arguments after the script; none are taken
 * @param {DriftDeps} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const {
    runGenerate = spawnDrizzleKit,
    runCheck = spawnDrizzleKit,
    readVersion = installedVersion,
    dbDir = DB_DIR,
    tempRoot = join(dbDir, COPY_PARENT),
    relativeOf = relative,
    removeDir = removeTree,
    now = Date.now,
    out = (line) => console.log(line),
    err = (line) => console.error(line),
  } = deps;

  if (argv.length > 0) {
    err(`${NAME}: takes no arguments, got ${argv.join(" ")}`);
    return 2;
  }

  let version;
  try {
    version = readVersion();
  } catch (error) {
    err(
      isGone(error)
        ? `${NAME}: drizzle-kit is not installed in packages/db - run pnpm install`
        : `${NAME}: cannot read the version of drizzle-kit: ${messageOf(error)}`,
    );
    return 2;
  }
  if (version !== DRIZZLE_KIT_VERSION) {
    err(
      `${NAME}: drizzle-kit ${version} is installed, the signs of its output are recorded for ${DRIZZLE_KIT_VERSION} - record test/schema-drift-fixture.ts again from the new version, check the signs of scripts/check-schema-drift.mjs against it and set DRIZZLE_KIT_VERSION`,
    );
    return 2;
  }

  let copy;
  try {
    mkdirSync(tempRoot, { recursive: true });
    removeStaleCopies(tempRoot, { removeDir, now, err });
    copy = mkdtempSync(join(tempRoot, COPY_PREFIX));
  } catch (error) {
    err(
      `${NAME}: cannot make a temporary directory in ${tempRoot}: ${messageOf(error)}`,
    );
    return 2;
  }
  let code;
  try {
    code = generateInCopy({ runGenerate, relativeOf, out, err }, dbDir, copy);
  } finally {
    try {
      removeDir(copy);
    } catch (error) {
      err(
        `${NAME}: cannot remove the temporary copy ${copy}: ${messageOf(error)}`,
      );
    }
  }
  if (code !== undefined) return code;

  const check = runCheck(drizzleKitSpec(dbDir, ["check"]));
  const run = ended(check);
  if (run.output.trim() !== "") out(run.output.trimEnd());
  const failure = spawnFailure(check, "check");
  if (failure !== undefined) {
    err(`${NAME}: ${failure}`);
    return 2;
  }
  const verdict = classifyCheck(run);
  if (verdict === "unfinished") {
    err(`${NAME}: drizzle-kit check: ${unfinishedWhy(check)}`);
    err(HINTS.check_unfinished);
    return 2;
  }
  if (verdict === "inconsistent") {
    err(`${NAME}: ${HINTS.check_failed}`);
    return 1;
  }
  out(`${NAME}: clean`);
  return 0;
}

/**
 * The exit code of the script started from the command line: that of `main`
 * when `isEntryOf` says this module is the one node runs, undefined when it
 * is not. Anything thrown - by the guard of the entry, by `main` or by what
 * it prints through - ends the run with 2 and its text, never with the 1 of
 * drift that node gives an uncaught throw.
 *
 * @param {() => boolean} isEntryOf
 * @param {string[]} argv
 * @param {DriftDeps} [deps]
 * @returns {number | undefined}
 */
export function runEntry(isEntryOf, argv, deps = {}) {
  try {
    return isEntryOf() ? main(argv, deps) : undefined;
  } catch (error) {
    const err = deps.err ?? ((line) => console.error(line));
    try {
      err(`${NAME}: the check did not take place: ${messageOf(error)}`);
    } catch {
      // stderr itself failed; the exit code still says what happened.
    }
    return 2;
  }
}

const code = runEntry(
  () => isEntry(import.meta.url, process.argv[1]),
  process.argv.slice(2),
);
if (code !== undefined) process.exitCode = code;
