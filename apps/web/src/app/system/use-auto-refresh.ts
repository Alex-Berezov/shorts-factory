import { useEffect, useRef, useTransition } from "react";

import { startAutoRefresh } from "@/lib/auto-refresh";

/**
 * Runs `onTick` inside a transition every refresh interval while the
 * component is mounted, and at once when a hidden tab is shown again, through
 * `startAutoRefresh`: a hidden tab skips its turn, and a tick waits for the
 * transition of the previous one to finish. The latest `onTick` is used, so
 * the interval is not restarted by a render.
 *
 * Returns the function for a refresh asked for by hand. It runs in the same
 * transition, so the timer sees it in flight and does not start another on
 * top of it, and it is skipped while one is already running.
 */
export function useAutoRefresh(onTick: () => void): () => void {
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(pending);
  const tickRef = useRef(onTick);

  useEffect(() => {
    pendingRef.current = pending;
    tickRef.current = onTick;
  });

  useEffect(
    () =>
      startAutoRefresh({
        refresh: () => startTransition(() => tickRef.current()),
        isHidden: () => document.hidden,
        isBusy: () => pendingRef.current,
        onVisibilityChange: (listener) => {
          document.addEventListener("visibilitychange", listener);
          return () =>
            document.removeEventListener("visibilitychange", listener);
        },
      }),
    [],
  );

  return () => {
    if (pendingRef.current) {
      return;
    }
    startTransition(() => tickRef.current());
  };
}
