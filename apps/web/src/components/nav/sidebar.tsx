import Link from "next/link";

import { NAV_SECTIONS } from "@/lib/nav";

/**
 * Side navigation of the dashboard. A server component on purpose: marking
 * the active section needs `usePathname` and with it a client component,
 * which belongs to E13-01 together with the rest of the shell polish.
 */
export function Sidebar() {
  return (
    <nav aria-label="Sections" className="w-48 shrink-0 border-r bg-muted/40">
      <div className="px-4 py-5 text-sm font-semibold">
        <Link href="/">Shorts Factory</Link>
      </div>
      <ul className="space-y-1 px-2">
        {NAV_SECTIONS.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="block rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
