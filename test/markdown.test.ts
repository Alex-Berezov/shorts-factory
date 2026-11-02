import { describe, expect, it } from "vitest";
import { headingsOf, proseLines } from "../scripts/lib/markdown.mjs";

/**
 * The prose lines of a markdown text (`scripts/lib/markdown.mjs`): a fenced
 * block of code opens and closes as CommonMark has it, so an example of a
 * heading or a row in one is not taken for one, and a line that only looks
 * like a fence leaves the rest of the text as it is.
 */
describe("the prose lines of markdown", () => {
  it("leave out a block of backticks and one of tildes", () => {
    expect(
      proseLines(
        ["a", "```md", "### x", "```", "b", "~~~", "| r |", "~~~", "c"].join(
          "\n",
        ),
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("close a block only at a fence of the same character, at least as long, with nothing after it", () => {
    expect(
      proseLines(
        ["````", "```", "~~~~", "```` text", "### in", "`````", "### out"].join(
          "\n",
        ),
      ),
    ).toEqual(["### out"]);
  });

  it("take a line of backticks with a backtick in its info string for inline code, not a fence", () => {
    expect(
      proseLines(["``` `x` ``` is code", "### E0-01. Heading"].join("\n")),
    ).toEqual(["``` `x` ``` is code", "### E0-01. Heading"]);
  });

  it("open a block of tildes whatever its info string", () => {
    expect(proseLines(["~~~ `x`", "### in", "~~~", "out"].join("\n"))).toEqual([
      "out",
    ]);
  });

  it("leave out a block that opens on the first line of a text with a byte order mark", () => {
    expect(proseLines("\uFEFF```\n### x\n```\nb")).toEqual(["b"]);
  });

  it("end lines at a line feed or a carriage return and a line feed", () => {
    expect(proseLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("the prose lines of markdown, HTML blocks", () => {
  it.each([
    ["a comment", ["<!--", "### E0-05. x", "-->"]],
    ["a comment closed on its first line", ["<!-- ### E0-05. x -->"]],
    ["a script block", ["<script>", "### E0-05. x", "</script>"]],
    ["a pre block", ["<pre>", "### E0-05. x", "</pre>"]],
    ["a style block", ["<style>", "### E0-05. x", "</style>"]],
    ["a processing instruction", ["<?php", "### E0-05. x", "?>"]],
    ["a declaration", ["<!DOCTYPE", "### E0-05. x", ">"]],
    ["a CDATA section", ["<![CDATA[", "### E0-05. x", "]]>"]],
    ["a div block, which ends at a blank line", ["<div>", "### E0-05. x"]],
  ])("leave out %s", (_, block) => {
    expect(proseLines(["a", ...block, "", "b"].join("\n"))).toEqual([
      "a",
      "",
      "b",
    ]);
  });

  it("let a block that is never closed run to the end of the text, as CommonMark has it", () => {
    expect(
      proseLines(["a", "<!--", "### E0-05. x", "", "b"].join("\n")),
    ).toEqual(["a"]);
  });

  it("keep the lines after a block that a blank line ended", () => {
    expect(proseLines(["<div>", "x", "", "### E0-05. x"].join("\n"))).toEqual([
      "",
      "### E0-05. x",
    ]);
  });

  it("keep a line that only begins like a tag, within a paragraph", () => {
    // A tag of a name no block has (type 7) does not interrupt a paragraph.
    expect(proseLines(["text", "<span>", "### E0-05. x"].join("\n"))).toEqual([
      "text",
      "<span>",
      "### E0-05. x",
    ]);
  });
});

describe("the headings of markdown", () => {
  const titles = (text: string) => headingsOf(text).map((h) => h.source);

  it.each([
    ["no indent", "### x"],
    ["an indent of one blank", " ### x"],
    ["an indent of three blanks", "   ### x"],
    ["a tab after the hashes", "###\tx"],
    ["a closing sequence", "### x ###"],
    ["blanks at the end", "### x   "],
  ])("take an ATX heading with %s", (_, line) => {
    expect(headingsOf(line)).toEqual([
      {
        level: 3,
        source: "x",
        plain: "x",
        texts: ["x"],
        markup: [],
      },
    ]);
  });

  it("do not take a line with an indent of four blanks or a tab, which is a block of code", () => {
    expect(titles("    ### x")).toEqual([]);
    expect(titles("\t### x")).toEqual([]);
  });

  it("take a setext heading, with its level", () => {
    expect(
      headingsOf("intro\n\nTitle\n=====\n\nOther\n-----").map(
        ({ level, source }) => ({ level, source }),
      ),
    ).toEqual([
      { level: 1, source: "Title" },
      { level: 2, source: "Other" },
    ]);
  });

  it("join the lines of a setext heading in its text as rendered, the break no character of it", () => {
    const [heading] = headingsOf("E0-05. Fifth\ntask\n---");
    expect(heading?.plain).toBe("E0-05. Fifthtask");
    expect(heading?.markup).toEqual([{ type: "softbreak", markup: "" }]);
  });

  it("take a heading at the start of a text with a byte order mark", () => {
    expect(headingsOf("\uFEFF### E0-05. x")).toEqual([
      expect.objectContaining({ level: 3, source: "E0-05. x" }),
    ]);
  });

  it("do not take --- after a blank line, which is a thematic break", () => {
    expect(titles("text\n\n---\n")).toEqual([]);
  });

  it("take a heading in a quote, a quote in a quote, a list item and a numbered one", () => {
    expect(titles("> ### a\n\n> > ### b\n\n- ### c\n\n1. ### d\n")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("do not take a heading in a fenced block of code or an HTML block", () => {
    expect(
      titles("```\n### a\n```\n\n<!--\n### b\n-->\n\n<div>\n### c\n"),
    ).toEqual([]);
  });

  it("give the text as rendered: escapes and entities decoded, a code span without its quotes", () => {
    const [heading] = headingsOf("### a \\*b\\* &amp; `c<d>` e");
    expect(heading?.plain).toBe("a *b* & c<d> e");
    expect(heading?.markup).toEqual([]);
  });

  it("name the markup that the renderer turns into something else", () => {
    const [heading] = headingsOf("### a _b_ [c](d) <i>e</i> ~~f~~");
    expect(heading?.markup.map((token) => token.type)).toEqual([
      "em_open",
      "em_close",
      "link_open",
      "link_close",
      "html_inline",
      "html_inline",
      "s_open",
      "s_close",
    ]);
  });

  it("keep the texts apart, a code span between two of them", () => {
    const [heading] = headingsOf("### a: `x` :b");
    expect(heading?.texts).toEqual(["a: ", " :b"]);
  });
});
