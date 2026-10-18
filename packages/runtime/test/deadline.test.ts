import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, settleWithin, withDeadline } from "../src/deadline.js";

/** A call to a socket that went silent: it never settles. */
const silent = (): Promise<never> => new Promise<never>(() => {});

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a call that never answers exactly when the timer fires", async () => {
    let verdict: unknown;
    void withDeadline(silent, 20, { unref: false }).catch((err: unknown) => {
      verdict = err;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(verdict).toBeInstanceOf(DeadlineError);
  });

  it("rejects with the error the caller names", async () => {
    class OwnTimeout extends Error {}
    const call = withDeadline(silent, 20, {
      unref: true,
      error: () => new OwnTimeout("cache get did not answer"),
    });
    const verdict = expect(call).rejects.toBeInstanceOf(OwnTimeout);
    await vi.advanceTimersByTimeAsync(20);

    await verdict;
  });

  it("answers with the call when it answers in time", async () => {
    await expect(
      withDeadline(async () => "ok", 20, { unref: false }),
    ).resolves.toBe("ok");
  });

  it("gives a deadline of zero to a call that answers at once, and gives up on one that does not", async () => {
    // Zero is a timer of the next turn of the loop, not a refusal up front:
    // an answer already on its way wins the race.
    await expect(
      withDeadline(async () => "ok", 0, { unref: false }),
    ).resolves.toBe("ok");

    const call = withDeadline(silent, 0, { unref: false });
    const verdict = expect(call).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(0);
    await verdict;
  });

  it("answers with the failure of the call when it fails in time", async () => {
    await expect(
      withDeadline(
        async () => {
          throw new Error("refused");
        },
        20,
        { unref: false },
      ),
    ).rejects.toThrow("refused");
  });

  it.each([
    ["answered", async () => "ok"],
    [
      "failed",
      async () => {
        throw new Error("refused");
      },
    ],
  ])(
    "leaves no timer behind once the call %s",
    async (_settled, run: () => Promise<string>) => {
      // A deadline left armed after the answer is a timer per request that
      // keeps a stopping process up for its whole length.
      await withDeadline(run, 60_000, { unref: false }).catch(() => {});

      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("settleWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the fallback exactly when the timer fires", async () => {
    let verdict: string | undefined;
    void settleWithin(silent, 20, "timeout", { unref: false }).then((v) => {
      verdict = v;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(verdict).toBe("timeout");
  });

  it("answers with the work when it answers in time", async () => {
    await expect(
      settleWithin(async () => "stamp", 20, "timeout", { unref: false }),
    ).resolves.toBe("stamp");
  });

  it("answers the fallback on a deadline of zero for work that never answers", async () => {
    let verdict: string | undefined;
    void settleWithin(silent, 0, "timeout", { unref: false }).then((v) => {
      verdict = v;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(verdict).toBe("timeout");
  });

  it("leaves no timer behind once the work answered", async () => {
    await settleWithin(async () => "stamp", 60_000, "timeout", {
      unref: true,
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the timer of a deadline", () => {
  /**
   * The timer the primitive armed, caught on its way out of `setTimeout`:
   * whether it holds the loop is a property of the real timer object.
   */
  function armedTimer(
    arm: (unref: boolean) => void,
    unref: boolean,
  ): NodeJS.Timeout {
    const armed: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = real(...args);
      armed.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      arm(unref);
    } finally {
      spy.mockRestore();
    }
    const [timer] = armed;
    if (timer === undefined) {
      throw new Error("the deadline armed no timer");
    }
    clearTimeout(timer);
    return timer;
  }

  const primitives: Array<[string, (unref: boolean) => void]> = [
    [
      "withDeadline",
      (unref) => {
        void withDeadline(silent, 60_000, { unref }).catch(() => {});
      },
    ],
    [
      "settleWithin",
      (unref) => {
        void settleWithin(silent, 60_000, undefined, { unref });
      },
    ],
  ];

  it.each(primitives)(
    "does not hold the process open when asked not to (%s)",
    (_name, arm) => {
      expect(armedTimer(arm, true).hasRef()).toBe(false);
    },
  );

  it.each(primitives)(
    "holds the process open otherwise, so the deadline gets its say (%s)",
    (_name, arm) => {
      expect(armedTimer(arm, false).hasRef()).toBe(true);
    },
  );
});
