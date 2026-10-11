import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { singleFlight } from "../src/lib/single-flight.js";

/** A call to a socket that went silent: it never settles. */
function hanging(): Promise<string> {
  return new Promise<string>(() => {});
}

/** A call whose answer the case decides on, and when. */
function deferred(): {
  run: () => Promise<string>;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
} {
  let resolve: (value: string) => void = () => {};
  let reject: (err: Error) => void = () => {};
  return {
    run: () =>
      new Promise<string>((onAnswer, onFailure) => {
        resolve = onAnswer;
        reject = onFailure;
      }),
    resolve: (value) => resolve(value),
    reject: (err) => reject(err),
  };
}

/** The gap between two polls of a page refreshed every 15 seconds. */
const POLL_GAP_MS = 15_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("singleFlight", () => {
  it("gives the callers that arrive while a call is in flight the same call", async () => {
    const call = deferred();
    const run = vi.fn(call.run);
    const shared = singleFlight(run);

    const first = shared();
    const second = shared();
    expect(run).toHaveBeenCalledTimes(1);
    call.resolve("answer");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "answer",
      "answer",
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * The bound the primitive exists for: callers that each gave up on a call
   * that hangs - on their own deadline, at any distance from each other -
   * leave that one call behind them, not one each.
   */
  it("keeps one call in flight however many callers give up on it", async () => {
    const run = vi.fn(hanging);
    const shared = singleFlight(run);

    for (let poll = 0; poll < 3; poll += 1) {
      void shared();
      // The poll gave up and went away; the next one arrives much later.
      await vi.advanceTimersByTimeAsync(POLL_GAP_MS);
    }

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * A failure that comes long after the callers joined is still theirs, and
   * it frees the slot: the dependency is asked again by the next caller, not
   * reported by the answer of the call that saw it fail.
   */
  it("hands a late failure to every caller that joined and then asks again", async () => {
    const call = deferred();
    const run = vi.fn(call.run);
    const shared = singleFlight(run);

    const first = shared();
    await vi.advanceTimersByTimeAsync(POLL_GAP_MS);
    const second = shared();
    call.reject(new Error("refused"));

    await expect(first).rejects.toThrow("refused");
    await expect(second).rejects.toThrow("refused");
    void shared().catch(() => {});
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("shares a call that throws before it returns a promise as a rejection", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error("refused at once");
      })
      .mockResolvedValueOnce("answer");
    const shared = singleFlight(run);

    // A rejection the caller can await, not an exception out of the call.
    const first = shared();
    const second = shared();
    await expect(first).rejects.toThrow("refused at once");
    await expect(second).rejects.toThrow("refused at once");
    expect(run).toHaveBeenCalledTimes(1);

    await expect(shared()).resolves.toBe("answer");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts a new call once the previous one failed", async () => {
    // Nothing is remembered: an outage that ended must not be reported by
    // the answer of the call that saw it.
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce("answer");
    const shared = singleFlight(run);

    await expect(shared()).rejects.toThrow("refused");
    await expect(shared()).resolves.toBe("answer");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts a new call once the previous one succeeded", async () => {
    const run = vi.fn(async () => "answer");
    const shared = singleFlight(run);

    await shared();
    await shared();

    expect(run).toHaveBeenCalledTimes(2);
  });
});
