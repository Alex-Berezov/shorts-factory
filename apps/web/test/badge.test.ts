import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders inline, so it can sit inside a span or a table cell", () => {
    const html = renderToStaticMarkup(
      createElement("span", null, createElement(Badge, null, "paused")),
    );
    expect(html).toMatch(
      /^<span><span class="[^"]*inline-flex[^"]*">paused<\/span><\/span>$/,
    );
  });
});
