"use client";

import { useRouter } from "next/navigation";

import { useAutoRefresh } from "./use-auto-refresh";

/**
 * Re-renders the server page every refresh interval while it is open. No
 * props and no data: the status is fetched by the server component on every
 * refresh, so nothing of it - and nothing of the config behind it - reaches
 * the client bundle (docs/DECISIONS.md, 10.10.2026).
 */
export function AutoRefresh() {
  const router = useRouter();
  useAutoRefresh(() => router.refresh());
  return null;
}
