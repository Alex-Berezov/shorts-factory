/**
 * The lines of a markdown document as its readers take them, for the root
 * scripts and tests that look for a heading or a row of a table in one
 * (`tracker-doc.mjs`, `test/debt-refs.ts`): an example in a fenced block of
 * code is not a heading or a row.
 */

/**
 * A fence of a block of code (CommonMark 4.5): up to three blanks, three or
 * more backticks or tildes, and the info string after them.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The lines of a markdown text that are prose: those of a fenced block of
 * code are left out, so an example of a heading or a row is not taken for
 * one. A block opens at a fence - one of backticks only when its info string
 * has no backtick: such a line is a paragraph with inline code - and
 * closes at a fence of the same character at least as long, with nothing but
 * blanks after it. Lines end at `\n` or `\r\n`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function proseLines(text) {
  /** @type {string[]} */
  const prose = [];
  /** @type {string | undefined} */
  let fence;
  for (const line of text.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    const marker = match?.[1];
    const rest = match?.[2] ?? "";
    if (fence === undefined) {
      if (marker === undefined || (marker[0] === "`" && rest.includes("`"))) {
        prose.push(line);
      } else {
        fence = marker;
      }
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      rest.trim() === ""
    ) {
      fence = undefined;
    }
  }
  return prose;
}
