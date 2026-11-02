import { afterEach, describe, expect, it, vi } from "vitest";
import { startedRuntime, waitFor } from "./helpers.int.js";

/**
 * The poll of the integration files (`helpers.int.ts`): it answers with the
 * first value its probe gives, and a probe that never answers - a Redis
 * command queued offline, a query on a dead socket - is a failure that names
 * the wait, by its deadline, not a case that runs out its own timeout and
 * names nothing; past that deadline it probes no more.
 */
describe("waitFor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails by its deadline, naming the wait, on a probe that never answers", async () => {
    vi.useFakeTimers();
    let outcome: unknown = "pending";
    void waitFor(() => new Promise<undefined>(() => undefined), {
      what: "the probe that never answers",
      timeoutMs: 1_000,
    }).then(
      (value) => {
        outcome = value;
      },
      (err: unknown) => {
        outcome = err;
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome instanceof Error ? outcome.message : outcome).toBe(
      "the probe that never answers: no answer within 1000 ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers with the first value that is not undefined", async () => {
    vi.useFakeTimers();
    const answers = [undefined, undefined, "ready", "late"];
    let probes = 0;
    let outcome: unknown = "pending";
    void waitFor(
      async () => {
        const value = answers[probes];
        probes += 1;
        return value;
      },
      {
        what: "the probe that answers third",
        timeoutMs: 1_000,
        intervalMs: 100,
      },
    ).then(
      (value) => {
        outcome = value;
      },
      (err: unknown) => {
        outcome = err;
      },
    );

    await vi.advanceTimersByTimeAsync(200);

    expect(outcome).toBe("ready");
    expect(probes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("probes no more after its deadline", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const verdict = expect(
      waitFor(
        async () => {
          probes += 1;
          return undefined;
        },
        {
          what: "the probe that never agrees",
          timeoutMs: 250,
          intervalMs: 100,
        },
      ),
    ).rejects.toThrow(/^the probe that never agrees: no answer within 250 ms$/);

    await vi.advanceTimersByTimeAsync(250);
    await verdict;
    const atDeadline = probes;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(atDeadline).toBe(3);
    expect(probes).toBe(atDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The guard of the cases that read the runtime a `beforeAll` started: one
 * that failed is named, not a TypeError on `undefined` that hides it.
 */
describe("startedRuntime", () => {
  it("refuses a runtime its beforeAll never started, naming the failed beforeAll", () => {
    expect(() => startedRuntime(undefined)).toThrow(/its beforeAll failed$/);
  });
});
