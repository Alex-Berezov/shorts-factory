/**
 * The shape of a parsed value for the root scripts (`scripts/*.mjs`): the one
 * predicate they read JSON and YAML through - a `package.json`
 * (`manifest.mjs`), what `docker compose config` prints and the Compose files
 * themselves (`compose-rules.mjs`, `compose-graph.mjs`).
 */

/**
 * Whether `value` is a mapping: an object, not a list, not null.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
