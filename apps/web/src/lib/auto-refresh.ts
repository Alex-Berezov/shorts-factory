/**
 * How often an open `/system` asks the server for a fresh render - the
 * "revalidate 15 s" of the task (docs/DECISIONS.md, 10.10.2026). The page
 * prints the same number, so the two cannot drift apart.
 */
export const REFRESH_INTERVAL_MS = 15_000;

export interface AutoRefreshOptions {
  /** Starts one refresh. */
  refresh: () => void;
  /** Whether the page is out of sight: a background tab skips its turn. */
  isHidden: () => boolean;
  /**
   * Whether the previous refresh is still in flight. During an outage a
   * render can take longer than the interval, and refreshes must not pile up
   * behind it.
   */
  isBusy: () => boolean;
  /**
   * Subscribes to the page being shown or hidden, and returns the function
   * that unsubscribes. A tab brought back to the front refreshes at once
   * instead of showing a snapshot from before it was hidden for up to one
   * more interval.
   */
  onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * Refreshes every `REFRESH_INTERVAL_MS` and as soon as a hidden page is
 * shown again, skipping a turn while the page is hidden or the last refresh
 * has not finished. Returns the function that stops it - the cleanup of the
 * effect that started it.
 */
export function startAutoRefresh(options: AutoRefreshOptions): () => void {
  const tick = () => {
    if (options.isHidden() || options.isBusy()) {
      return;
    }
    options.refresh();
  };
  const timer = setInterval(tick, REFRESH_INTERVAL_MS);
  const unsubscribe = options.onVisibilityChange(tick);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
