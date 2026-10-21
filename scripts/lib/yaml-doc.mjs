/**
 * The one fail-closed reading of a YAML text for the root scripts and the
 * tests of the root project: the Compose files of the compose gate
 * (`rootOf` of `scripts/lib/compose-graph.mjs`, ADR-0014), and every YAML
 * file a test of the root project reads (`parseRepoYaml` of
 * `test/repo-files.ts`, which the workflow of CI in `test/workflow.ts` reads
 * through too, decision R2 of E0-12N). A text is one document the
 * parser takes as it is, built into plain values; anything else - no
 * document, more than one, an error or a warning of the parser (a tab in the
 * indentation, a key twice, a tag it does not know), aliases past the limit,
 * a value the parser cannot build - comes back as the reason, never as a
 * value read in part. Each reader says the reason in its own words.
 */
import { parseAllDocuments } from "yaml";

/**
 * How a reading ended: the value, or why there is none.
 *
 * @typedef {{ kind: "value", value: unknown }
 *   | { kind: "empty" }
 *   | { kind: "documents", count: number }
 *   | { kind: "notes", notes: { code: string, line: number | null, message: string }[] }
 *   | { kind: "aliases" }
 *   | { kind: "unbuilt", message: string }} YamlReading
 */

/** The most aliases a value expands, as the parser counts them. */
const MAX_ALIAS_COUNT = 100;

/**
 * The one document of `text`, read fail-closed (see the module).
 *
 * @param {string} text
 * @param {{ merge?: boolean }} [options] `merge`: expand the `<<` key, as
 *   Compose does
 * @returns {YamlReading}
 */
export function readYaml(text, { merge = false } = {}) {
  const [doc, ...more] = parseAllDocuments(text, { merge });
  if (doc === undefined) return { kind: "empty" };
  if (more.length > 0) return { kind: "documents", count: more.length + 1 };
  const notes = [...doc.errors, ...doc.warnings];
  if (notes.length > 0) {
    return {
      kind: "notes",
      notes: notes.map((note) => ({
        code: note.code,
        line: note.linePos?.[0].line ?? null,
        message: note.message.split("\n")[0] ?? "",
      })),
    };
  }
  try {
    return {
      kind: "value",
      value: doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }),
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The aliases expand past the limit (`Excessive alias count`, measured on
    // yaml 2.9.0): the message of the parser says so in its own words.
    if (error instanceof ReferenceError && /alias count/i.test(error.message)) {
      return { kind: "aliases" };
    }
    // Any other value the parser cannot build - a merge key that is not a
    // mapping, an alias before its anchor - by the reason it gives.
    return { kind: "unbuilt", message: error.message };
  }
}
