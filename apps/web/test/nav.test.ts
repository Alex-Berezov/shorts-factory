import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "@/components/nav/sidebar";
import { NAV_SECTIONS } from "@/lib/nav";

const APP_DIR = fileURLToPath(new URL("../src/app", import.meta.url));

describe("NAV_SECTIONS", () => {
  it("lists the eight sections of the dashboard in pipeline order", () => {
    expect(NAV_SECTIONS).toEqual([
      { href: "/radar", label: "Radar" },
      { href: "/inbox", label: "Inbox" },
      { href: "/ideas", label: "Ideas" },
      { href: "/production", label: "Production" },
      { href: "/analytics", label: "Analytics" },
      { href: "/experiments", label: "Experiments" },
      { href: "/localization", label: "Localization" },
      { href: "/system", label: "System" },
    ]);
  });

  it.each(NAV_SECTIONS.map((section) => section.href))(
    "has a page behind %s",
    (href) => {
      expect(existsSync(`${APP_DIR}${href}/page.tsx`)).toBe(true);
    },
  );
});

describe("Sidebar", () => {
  it("links every section, in the order of the list", () => {
    const html = renderToStaticMarkup(createElement(Sidebar));
    const hrefs = [...html.matchAll(/<li><a [^>]*href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(hrefs).toEqual(NAV_SECTIONS.map((section) => section.href));
    for (const { label } of NAV_SECTIONS) {
      expect(html).toContain(`>${label}</a>`);
    }
  });
});
