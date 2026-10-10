import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REFRESH_INTERVAL_MS, startAutoRefresh } from "@/lib/auto-refresh";

// Web tests run in node, without a DOM to mount into. The hooks the refresh
// is wired through are replaced by synchronous ones - an effect runs when it
// is declared and returns its cleanup to `cleanups` - so a component can be
// called as a function and its timers driven by the fake clock.
const cleanups: (() => void)[] = [];
let transitionPending = false;
const hookTransition = vi.fn((action: () => void) => action());

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | undefined) => {
      const cleanup = effect();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
    },
    useRef: <T>(initial: T) => ({ current: initial }),
    useTransition: () => [transitionPending, hookTransition],
  };
});

const router = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { AutoRefresh } = await import("@/app/system/auto-refresh");
const { default: SystemError } = await import("@/app/system/error");

let hidden = false;
const visibilityListeners = new Set<() => void>();

/** Hides or shows the page the way a browser does: flag, then event. */
function setHidden(value: boolean): void {
  hidden = value;
  for (const listener of [...visibilityListeners]) {
    listener();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  transitionPending = false;
  router.refresh.mockClear();
  hookTransition.mockClear();
  visibilityListeners.clear();
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") {
        visibilityListeners.add(listener);
      }
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") {
        visibilityListeners.delete(listener);
      }
    },
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A refresh driven by the given flags, with its stop function. */
function started(flags: { hidden?: boolean; busy?: boolean } = {}) {
  const state = { hidden: false, busy: false, ...flags };
  const refresh = vi.fn();
  let shown: (() => void) | undefined;
  const stop = startAutoRefresh({
    refresh,
    isHidden: () => state.hidden,
    isBusy: () => state.busy,
    onVisibilityChange: (listener) => {
      shown = listener;
      return () => {
        shown = undefined;
      };
    },
  });
  /** Flips the page's visibility and fires the change, if still subscribed. */
  const toggle = (value: boolean) => {
    state.hidden = value;
    shown?.();
  };
  return { refresh, stop, state, toggle };
}

describe("startAutoRefresh", () => {
  it("refreshes every 15 seconds", () => {
    expect(REFRESH_INTERVAL_MS).toBe(15_000);
    const { refresh, stop } = started();

    vi.advanceTimersByTime(14_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops for good when its cleanup runs", () => {
    const { refresh, stop } = started();
    stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("skips its turn while the page is hidden and resumes when shown", () => {
    const { refresh, stop, state } = started({ hidden: true });

    vi.advanceTimersByTime(45_000);
    expect(refresh).not.toHaveBeenCalled();
    state.hidden = false;
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("refreshes at once when a hidden page is shown again", () => {
    const { refresh, stop, toggle } = started({ hidden: true });

    vi.advanceTimersByTime(20_000);
    toggle(true);
    expect(refresh).not.toHaveBeenCalled();
    toggle(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops listening to the page when its cleanup runs", () => {
    const { refresh, stop, toggle } = started({ hidden: true });
    stop();

    toggle(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not start a refresh while the last one is in flight", () => {
    const { refresh, stop, state } = started({ busy: true });

    vi.advanceTimersByTime(45_000);
    expect(refresh).not.toHaveBeenCalled();
    state.busy = false;
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("AutoRefresh", () => {
  it("refreshes the page on the interval and not in a hidden tab", () => {
    AutoRefresh();

    vi.advanceTimersByTime(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    hidden = true;
    vi.advanceTimersByTime(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes as soon as the tab comes back", () => {
    AutoRefresh();

    setHidden(true);
    vi.advanceTimersByTime(40_000);
    expect(router.refresh).not.toHaveBeenCalled();
    setHidden(false);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for a refresh still in flight", () => {
    transitionPending = true;
    AutoRefresh();

    vi.advanceTimersByTime(30_000);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("stops when unmounted", () => {
    AutoRefresh();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }

    vi.advanceTimersByTime(60_000);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(visibilityListeners.size).toBe(0);
  });
});

/** The `onClick` of the Retry button in the tree a component returned. */
function retryButton(node: unknown): () => void {
  const found = findRetry(node);
  if (found === undefined) {
    throw new Error("no Retry button");
  }
  return found;
}

function findRetry(node: unknown): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRetry(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isValidElement<{ children?: unknown; onClick?: () => void }>(node)) {
    return undefined;
  }
  if (node.props.children === "Retry" && node.props.onClick !== undefined) {
    return node.props.onClick;
  }
  return findRetry(node.props.children);
}

describe("SystemError", () => {
  it("retries on its own on the refresh interval", () => {
    const reset = vi.fn();
    SystemError({ error: new Error("render failed"), reset });

    vi.advanceTimersByTime(14_999);
    expect(reset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("retries by hand through the refresh the timer watches", () => {
    const reset = vi.fn();
    const tree = SystemError({ error: new Error("render failed"), reset });

    retryButton(tree)();
    expect(hookTransition).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("does not retry by hand on top of a retry in flight", () => {
    transitionPending = true;
    const reset = vi.fn();
    const tree = SystemError({ error: new Error("render failed"), reset });

    retryButton(tree)();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("shows the digest and never the message", () => {
    const error = Object.assign(new Error("db at 10.0.0.5 refused"), {
      digest: "1234567",
    });
    const html = renderToStaticMarkup(SystemError({ error, reset: vi.fn() }));
    expect(html).toContain("digest 1234567");
    expect(html).toContain("Retry");
    expect(html).not.toContain("10.0.0.5");
  });

  it("prints no digest line when there is none", () => {
    const html = renderToStaticMarkup(
      SystemError({ error: new Error("x"), reset: vi.fn() }),
    );
    expect(html).not.toContain("digest");
  });
});
