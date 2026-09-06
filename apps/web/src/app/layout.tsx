import type { ReactNode } from "react";

import "./globals.css";

/**
 * Dashboard shell (epic E13).
 * Nav sections: Radar / Inbox / Ideas / Production / Analytics /
 * Experiments / Localization / System.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
