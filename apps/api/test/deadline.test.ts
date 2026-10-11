import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, withDeadline } from "../src/lib/deadline.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline", () => {
  it("gives up on a call that never answers when the timer fires", async () => {
    // A call to a socket that went silent: it never settles.
    const call = withDeadline(() => new Promise<never>(() => {}), 20);
    const verdict = expect(call).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(20);

    await verdict;
  });

  it("answers with the call when it answers in time", async () => {
    await expect(withDeadline(async () => "ok", 20)).resolves.toBe("ok");
  });

  it("answers with the failure of the call when it fails in time", async () => {
    await expect(
      withDeadline(async () => {
        throw new Error("refused");
      }, 20),
    ).rejects.toThrow("refused");
  });
});
