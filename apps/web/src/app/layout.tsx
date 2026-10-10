import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/nav/sidebar";

import "./globals.css";

export const metadata: Metadata = {
  title: "Shorts Factory",
};

/**
 * Dashboard shell: the side navigation and the page next to it. Every route
 * under it sits behind the basic auth of `src/middleware.ts`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          {/* A div, not `main`: every page renders its own `main` landmark. */}
          <div className="flex-1 overflow-x-auto p-6">{children}</div>
        </div>
      </body>
    </html>
  );
}
