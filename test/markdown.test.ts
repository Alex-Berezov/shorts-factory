import { describe, expect, it } from "vitest";
import { proseLines } from "../scripts/lib/markdown.mjs";

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

  it("end lines at a line feed or a carriage return and a line feed", () => {
    expect(proseLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});
