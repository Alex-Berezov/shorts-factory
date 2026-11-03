/**
 * A markdown document as its readers take it, for the root scripts and tests
 * that look for a heading or a row of a table in one (`tracker-doc.mjs`,
 * `test/debt-refs.ts`): an example in a fenced block of code or in an HTML
 * block is not a heading or a row, and a heading is whatever CommonMark makes
 * one - ATX with up to three blanks before it, setext, in a list or a quote.
 *
 * The rules are the parser's, not a copy of them (markdown-it, a CommonMark
 * parser with the tables and strikethrough of GitHub; `html: true`, as GitHub
 * reads a document). This is the only module that imports it.
 */
import MarkdownIt from "markdown-it";

const parser = new MarkdownIt({ html: true });

/** Parsed lines end at `\n`, `\r\n` or a lone `\r`, as the parser has it. */
const NEWLINE = /\r\n?|\n/;

/**
 * `text` without the byte order mark it may start with: GitHub and VS Code
 * drop it, the parser takes it for a character of the first line.
 *
 * @param {string} text
 * @returns {string}
 */
const unmarked = (text) => text.replace(/^\uFEFF/, "");

/**
 * The lines of a markdown text that are prose, each with its index in the
 * text (from 0): those of a fenced block of code and of an HTML block (a
 * comment, `<script>`, `<div>` up to a blank line, ...) are left out, so an
 * example of a heading or a row is not taken for one. Blocks are CommonMark's,
 * in a list or a quote too; one that is not closed runs to the end of the
 * text. A byte order mark is not text. Two lines left next to each other are
 * next to each other in the text only when their indexes are: a block left
 * out between them parts them, as it parts the rows of a table.
 *
 * @param {string} marked
 * @returns {{ text: string, index: number }[]}
 */
export function proseLineEntries(marked) {
  const text = unmarked(marked);
  const lines = text.split(NEWLINE);
  const skipped = new Set();
  for (const token of parser.parse(text, {})) {
    if (token.map === null) continue;
    if (token.type !== "fence" && token.type !== "html_block") continue;
    for (let line = token.map[0]; line < token.map[1]; line += 1) {
      skipped.add(line);
    }
  }
  return lines
    .map((line, index) => ({ text: line, index }))
    .filter(({ index }) => !skipped.has(index));
}

/**
 * The lines of a markdown text that are prose (`proseLineEntries`), without
 * their indexes.
 *
 * @param {string} marked
 * @returns {string[]}
 */
export function proseLines(marked) {
  return proseLineEntries(marked).map(({ text }) => text);
}

/**
 * A heading of a markdown text.
 *
 * - `level` - 1 to 6.
 * - `source` - its text as written, closing `#` and the blanks around cut.
 * - `plain` - its text as rendered, where the renderer changes nothing but
 *   escapes and entities: the characters of `text` and `code_inline` tokens.
 *   The anchor GitHub gives is made of this, not of `source`.
 * - `texts` - the contents of its `text` tokens, one by one: what an emoji
 *   `:name:` is looked for in (a code span is not).
 * - `markup` - the inline tokens that are not text or code, which make the
 *   rendered text differ from `plain` (emphasis, a link, inline HTML, an
 *   image, strikethrough, a line break): the type of the token and its markup.
 *
 * @typedef {{
 *   level: number,
 *   source: string,
 *   plain: string,
 *   texts: string[],
 *   markup: { type: string, markup: string }[],
 * }} Heading
 */

/**
 * The headings of a markdown text, in order: ATX (up to three blanks
 * before `#`, as CommonMark has it), setext, in a list or a quote, outside
 * a fenced block of code and an HTML block. The one rule of a heading for
 * every reader. A byte order mark is not text.
 *
 * @param {string} text
 * @returns {Heading[]}
 */
export function headingsOf(text) {
  /** @type {Heading[]} */
  const headings = [];
  const tokens = parser.parse(unmarked(text), {});
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    if (open?.type !== "heading_open" || inline?.type !== "inline") continue;
    let plain = "";
    /** @type {string[]} */
    const texts = [];
    /** @type {{ type: string, markup: string }[]} */
    const markup = [];
    for (const child of inline.children ?? []) {
      if (child.type === "text" || child.type === "code_inline") {
        plain += child.content;
        if (child.type === "text") texts.push(child.content);
      } else {
        markup.push({ type: child.type, markup: child.markup });
      }
    }
    headings.push({
      level: Number(open.tag.slice(1)),
      source: inline.content,
      plain,
      texts,
      markup,
    });
  }
  return headings;
}
