import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "../test-support/within.js";

/** A wait on something that went silent: it never settles. */
const silent = (): Promise<never> => new Promise<never>(() => {});

describe("within", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names what it waited on and for how long when no answer comes", async () => {
    const wait = within(silent(), 250, "the start of the api");
    const verdict = expect(wait).rejects.toThrow(
      "the start of the api: no answer within 250 ms",
    );

    await vi.advanceTimersByTimeAsync(250);

    await verdict;
  });

  it("answers with the work and drops its timer when the work answers in time", async () => {
    await expect(within(Promise.resolve("ready"), 250, "a wait")).resolves.toBe(
      "ready",
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the failure of the work through as it is and drops its timer", async () => {
    const failure = new Error("connection refused");

    await expect(within(Promise.reject(failure), 250, "a wait")).rejects.toBe(
      failure,
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds the process open while it waits, so its deadline always fires", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const wait = within(silent(), 250, "a wait");
    const verdict = expect(wait).rejects.toThrow("a wait: no answer");

    expect(timers).toHaveBeenCalledTimes(1);
    expect(timers.mock.results[0]?.value.hasRef()).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    await verdict;
  });

  it("fails at once with no time to wait", async () => {
    const wait = within(silent(), 0, "a wait");
    const verdict = expect(wait).rejects.toThrow(
      "a wait: no answer within 0 ms",
    );

    await vi.advanceTimersByTimeAsync(0);

    await verdict;
  });

  it("keeps its verdict when the work answers after the deadline", async () => {
    let answer: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const wait = within(late, 250, "a wait");
    const verdict = expect(wait).rejects.toThrow(
      "a wait: no answer within 250 ms",
    );

    await vi.advanceTimersByTimeAsync(250);
    answer("too late");
    await vi.advanceTimersByTimeAsync(0);

    await verdict;
  });
});
