/**
 * The graph of Compose files a root Compose file pulls in: the root, every
 * file of its `include` and every `file` of an `extends` of a service, and
 * theirs in turn - the files the stack of the operator is made of. The compose
 * gate holds each of them to the Compose files its `when` is chosen on
 * (`COMPOSE_SOURCES` and rules 14 and 15 of scripts/compose-rules.mjs), and
 * hands the reader that list as `admits`: a file outside it is named, not
 * read. The root mapping of each file read is handed back as well (`roots`):
 * rule 17 holds the values of the stack to what the files of the graph write,
 * and reads them there, not from a second parse of its own.
 *
 * The files are parsed by `yaml` (docs/adr/0014-compose-graph-gate.md), the
 * way Compose parses them: a quoted key, a key with a space before its colon,
 * an indented document, a JSON or flow root, a flow mapping, a BOM, an escape
 * in double quotes, an alias and a merge key `<<` all read as Compose reads
 * them (measured on Compose 5.5.1, tasks/2026-10-20-E0-12K.md). The reading is
 * fail-closed: whatever the reader does not know how Compose takes - more
 * than one document, an error or a warning of the parser (a tag such as
 * `!reset` or `!override` included), a root that is not a mapping, an
 * `include` or an `extends` in another form, a path the interpolation would
 * fill in, a cyclic alias, a value the parser cannot build (a merge key that
 * is not a mapping), a target that is not there - is a problem of its own with
 * the file and the field and the reason the parser gave, never a file read as
 * clean.
 */
import { dirname, resolve } from "node:path";
import { isGone } from "./files.mjs";
import { isRecord } from "./json.mjs";
import { readYaml } from "./yaml-doc.mjs";

/**
 * What the reader reads the files through.
 *
 * @typedef {object} GraphReaders
 * @property {(path: string) => string | null} read contents of a file, null
 *   if there is none (`readIfFile` of scripts/lib/files.mjs); any other
 *   failure is thrown and not caught here
 * @property {(path: string) => string} realpath the canonical path of an
 *   existing one; a path that is not there throws with the code `ENOENT`
 *   (`isGone`), any other failure is thrown and not caught here
 * @property {(path: string) => boolean} admits whether a file may be read:
 *   the entry, and an edge by the path written and by its realpath both. A
 *   file it does not admit is not opened and not followed - its edge stays in
 *   `references` for the caller to refuse. Required: the reader has no list
 *   of its own, and a walk without one would open whatever an `include`
 *   names, a `.env` included
 */

/**
 * One edge of the graph: a path a file names.
 *
 * @typedef {object} ComposeReference
 * @property {string} from the canonical file that names it
 * @property {string} field where it stands there (`include[0].path[1]`,
 *   `services.api.extends.file`)
 * @property {string} written the path as written, resolved against the
 *   directory of `from` and not through the realpath
 * @property {string} target its canonical path
 */

/**
 * The root mapping of one file of the graph, as the reader parsed it.
 *
 * @typedef {object} ComposeRoot
 * @property {string} file the canonical path of the file
 * @property {Record<string, unknown>} root its root mapping, aliases and merge
 *   keys expanded
 */

/**
 * @typedef {object} ComposeGraph
 * @property {string[]} files the canonical path of every file of the graph
 *   that was read, the entry first, in the order of the walk, each once
 * @property {ComposeRoot[]} roots the root mapping of every file of `files`
 *   that parsed, in the same order; a file that did not is in `problems`
 * @property {ComposeReference[]} references every edge that resolved, to a
 *   file `admits` takes or not
 * @property {string[]} problems what keeps the graph from being read whole,
 *   one line each
 */

/**
 * Whether `value` refers to itself through an alias (`a: &a [*a]`): the
 * parser expands it into an object that is its own descendant, which any
 * walk of it would follow forever. Only the objects on the way down are
 * compared, so a value shared by two aliases is not a cycle.
 *
 * @param {unknown} value
 * @param {Set<object>} [above] the objects on the way down to `value`
 * @returns {boolean}
 */
function isCyclic(value, above = new Set()) {
  if (typeof value !== "object" || value === null) return false;
  if (above.has(value)) return true;
  above.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const cyclic = children.some((child) => isCyclic(child, above));
  above.delete(value);
  return cyclic;
}

/**
 * The root mapping of the Compose file `file` with the text `text`, or the
 * problems that keep it from being read.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{ root: Record<string, unknown> | null, problems: string[] }}
 */
function rootOf(file, text) {
  /** @param {string} why */
  const refused = (why) => ({ root: null, problems: [`${file}: ${why}`] });
  // `merge`: the `<<` key, which Compose expands (measured).
  const reading = readYaml(text, { merge: true });
  switch (reading.kind) {
    case "value":
      break;
    // An empty file: Compose refuses it (`empty compose file`, measured).
    case "empty":
      return refused("no YAML document - Compose refuses an empty file");
    case "documents":
      return refused(
        `${reading.count} YAML documents - Compose reads every one, the gate reads a file of one`,
      );
    case "notes":
      return {
        root: null,
        problems: reading.notes.map(
          (note) =>
            `${file}: ${note.code} at line ${note.line ?? "?"} - the gate does not read a file the parser does not take as it is`,
        ),
      };
    case "aliases":
      return refused("aliases the gate does not expand (past maxAliasCount)");
    case "unbuilt":
      return refused(`the parser cannot build it (${reading.message})`);
  }
  const value = reading.value;
  if (isCyclic(value)) return refused("a cyclic alias - Compose refuses it");
  if (!isRecord(value)) return refused("the root is not a mapping");
  return { root: value, problems: [] };
}

/**
 * The paths a parsed Compose file names, each with its field, and the
 * problems of the fields that name one in a form the reader does not take.
 *
 * `include` is a list, or null, which Compose takes for none (measured); an
 * entry is a path or a mapping with `path` alone, a
 * path or a list of paths - `project_directory` and `env_file` there would
 * move the directory or the environment of the included files past the gate.
 * `extends` counts in `services.<name>.extends` only: a name (`extends: base`)
 * or `{ service }` stay in the file, `{ service, file }` names another; the
 * `extends` of `environment` or of `labels` is a value, not an edge.
 *
 * @param {Record<string, unknown>} root
 * @returns {{ paths: { field: string, path: string }[], problems: string[] }}
 */
function namedPaths(root) {
  /** @type {{ field: string, path: string }[]} */
  const paths = [];
  /** @type {string[]} */
  const problems = [];
  const { include, services } = root;
  if (include !== undefined && include !== null) {
    if (!Array.isArray(include)) {
      problems.push("include is not a list");
    } else {
      for (const [index, entry] of include.entries()) {
        const field = `include[${index}]`;
        if (typeof entry === "string") {
          paths.push({ field, path: entry });
          continue;
        }
        if (!isRecord(entry)) {
          problems.push(`${field} is neither a path nor a mapping with path`);
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (key !== "path") {
            problems.push(
              `${field}.${key} - an include takes path alone, the gate checks no other field`,
            );
          }
        }
        const { path } = entry;
        if (typeof path === "string") {
          paths.push({ field: `${field}.path`, path });
        } else if (Array.isArray(path)) {
          for (const [at, item] of path.entries()) {
            if (typeof item === "string") {
              paths.push({ field: `${field}.path[${at}]`, path: item });
            } else {
              problems.push(`${field}.path[${at}] is not a path`);
            }
          }
        } else {
          problems.push(`${field}.path is neither a path nor a list of paths`);
        }
      }
    }
  }
  if (services !== undefined) {
    if (!isRecord(services)) {
      problems.push("services is not a mapping");
    } else {
      for (const [name, service] of Object.entries(services)) {
        if (!isRecord(service)) {
          problems.push(`services.${name} is not a mapping`);
          continue;
        }
        const { extends: base } = service;
        const field = `services.${name}.extends`;
        if (base === undefined || typeof base === "string") continue;
        if (!isRecord(base)) {
          problems.push(
            `${field} is neither a service name nor a mapping with service`,
          );
          continue;
        }
        for (const key of Object.keys(base)) {
          if (key !== "service" && key !== "file") {
            problems.push(
              `${field}.${key} - an extends takes service and file alone`,
            );
          }
        }
        if (typeof base.service !== "string") {
          problems.push(`${field}.service is not a service name`);
        }
        if (base.file === undefined) continue;
        if (typeof base.file === "string") {
          paths.push({ field: `${field}.file`, path: base.file });
        } else {
          problems.push(`${field}.file is not a path`);
        }
      }
    }
  }
  return { paths, problems };
}

/**
 * The graph of the Compose files `entry` pulls in. `entry` is canonical
 * already; every other file is taken by its canonical path, so a file named
 * twice, or a cycle of files, is read once and the walk ends. An entry
 * `admits` does not take is not read: the graph is empty.
 *
 * @param {string} entry the canonical path of the root Compose file
 * @param {GraphReaders} readers
 * @returns {ComposeGraph}
 */
export function composeGraph(entry, { read, realpath, admits }) {
  if (typeof admits !== "function") {
    throw new TypeError(
      "composeGraph: admits is required - the files the walk may open",
    );
  }
  /** @type {string[]} */
  const files = [];
  /** @type {ComposeReference[]} */
  const references = [];
  /** @type {ComposeRoot[]} */
  const roots = [];
  /** @type {string[]} */
  const problems = [];
  const queue = admits(entry) ? [entry] : [];
  const seen = new Set(queue);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    files.push(file);
    const text = read(file);
    if (text === null) {
      problems.push(`${file}: not a file`);
      continue;
    }
    const parsed = rootOf(file, text);
    problems.push(...parsed.problems);
    if (parsed.root === null) continue;
    roots.push({ file, root: parsed.root });
    const named = namedPaths(parsed.root);
    problems.push(...named.problems.map((problem) => `${file}: ${problem}`));
    for (const { field, path } of named.paths) {
      if (path.includes("$")) {
        // Compose fills it in from .env or the environment, and `resolve`
        // would read `${X}/..` as a directory: refused before any join.
        problems.push(
          `${file}: ${field} is an interpolated path (${path}) - Compose fills it in from .env, the gate cannot know the file`,
        );
        continue;
      }
      const written = resolve(dirname(file), path);
      /** @type {string} */
      let target;
      try {
        target = realpath(written);
      } catch (error) {
        if (!isGone(error)) throw error;
        problems.push(`${file}: ${field} names ${written}, which is not there`);
        continue;
      }
      references.push({ from: file, field, written, target });
      // Not opened: the caller refuses the edge, and what lies outside the
      // files it admits - a `.env`, say - is not read on the way.
      if (!admits(written) || !admits(target)) continue;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return { files, roots, references, problems };
}
