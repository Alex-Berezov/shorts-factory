/**
 * The rule against the YouTube Data API search call (100 quota units per
 * call, banned project-wide): one boundary for the gate that scans the tree
 * (`scripts/check-no-search-list.mjs`) and for the standards hook that looks
 * at each line written (rule S04 of `.claude/hooks/rules.sf.json`). The
 * selftest of the harness loads this module and holds the pattern, the skip
 * and the files of S04 to the sources here, so the hook cannot pass a line
 * the gate refuses, or the other way round.
 *
 * A line that names the call is refused unless it is a line comment that
 * carries the mark `no-search-list: allowed` and nothing that could end the
 * comment before the end of the line (`ALLOWED`). The mark after code, inside
 * a string of a line of code, or on a line of a block comment lets nothing
 * through.
 */

/** The extensions of the source files the rule looks at, anywhere in the tree. */
export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * A line that names the call, its endpoint or the search resource. The
 * slashes of the endpoint escaped, so the line of the pattern does not match
 * itself.
 */
export const BANNED =
  /search\.list|youtube\.search\s*\(|\/youtube\/v3\/search/u;

/**
 * A line comment carrying the mark: the only line `BANNED` lets through. A
 * rule that sees one line at a time (the hook sees the lines written, not the
 * file) cannot know what the lines above left open, so the line must be a
 * comment in every state the line before can leave it in:
 *
 * - it starts with `//`, which starts a comment wherever code may stand (a
 *   regular expression cannot start with two slashes);
 * - no `*` followed by `/`: inside a block comment it stays in the comment;
 * - no backtick and no `{`: inside a template literal it stays in the text,
 *   no `${` opens code in it;
 * - no `<`: in the text of JSX, where `//` is text, only a tag or `{` leaves
 *   it, so neither `<` nor `{` may stand in the line;
 * - no `"` and no `'`: inside a string continued from the line before by a
 *   backslash it stays in the string;
 * - no line terminator of JavaScript but the one that ends it (a lone CR,
 *   U+2028, U+2029 - the properties `Zl` and `Zp`, hence the flag `u`): the
 *   lines are split at LF only, while JavaScript starts a line of code after
 *   any of them.
 *
 * A line of a block comment (opening it, or going on with a `*`) is not let
 * through: whether a `*` at the head of a line goes on with a comment or
 * multiplies, and whether a block comment closed before the call, depends on
 * the lines above.
 */
export const ALLOWED =
  /^\s*\/\/(?:(?!\*\/)[^`'"{<\r\p{Zl}\p{Zp}])*no-search-list: allowed(?:(?!\*\/)[^`'"{<\r\p{Zl}\p{Zp}])*\r?$/u;

/**
 * Whether `line` breaks the rule.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function breaksRule(line) {
  return BANNED.test(line) && !ALLOWED.test(line);
}

/**
 * Whether `path` is a source file the rule looks at.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isSource(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.includes(name.slice(dot));
}
