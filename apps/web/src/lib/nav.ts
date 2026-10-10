/** One section of the dashboard in the side navigation. */
export interface NavSection {
  href: string;
  label: string;
}

/**
 * The sections in pipeline order, from where ideas come in to the state of
 * the machinery behind them. Publishing joins the list in E13-01.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { href: "/radar", label: "Radar" },
  { href: "/inbox", label: "Inbox" },
  { href: "/ideas", label: "Ideas" },
  { href: "/production", label: "Production" },
  { href: "/analytics", label: "Analytics" },
  { href: "/experiments", label: "Experiments" },
  { href: "/localization", label: "Localization" },
  { href: "/system", label: "System" },
];
