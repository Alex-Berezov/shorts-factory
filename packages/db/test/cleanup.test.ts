import { describe, expect, it, vi } from "vitest";
import { withCleanup } from "../src/cleanup.js";

/**
 * The one "which failure is thrown" policy of `@sf/db`: the migration lock
 * (`src/migrate.ts`, inside the package - the barrel does not export it) and
 * the CLI entry points (`src/cli/run.ts`) go through it.
 */
describe("withCleanup", () => {
  it("returns the body's result and cleans up once", async () => {
    const cleanup = vi.fn(async () => undefined);
    const onCleanupError = vi.fn();

    await expect(
      withCleanup(async () => 42, cleanup, onCleanupError),
    ).resolves.toBe(42);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onCleanupError).not.toHaveBeenCalled();
  });

  it("throws the body's failure and hands the cleanup's to the callback", async () => {
    const cause = new Error("migration failed");
    const cleanupError = new Error("write CONNECTION_ENDED");
    const onCleanupError = vi.fn();

    await expect(
      withCleanup(
        async () => {
          throw cause;
        },
        async () => {
          throw cleanupError;
        },
        onCleanupError,
      ),
    ).rejects.toBe(cause);
    expect(onCleanupError).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
  });

  it("still cleans up after a failed body", async () => {
    const cleanup = vi.fn(async () => undefined);

    await expect(
      withCleanup(
        async () => {
          throw new Error("migration failed");
        },
        cleanup,
        () => undefined,
      ),
    ).rejects.toThrow("migration failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("throws the cleanup's failure when only the cleanup failed", async () => {
    const cleanupError = new Error("write CONNECTION_ENDED");
    const onCleanupError = vi.fn();

    await expect(
      withCleanup(
        async () => "done",
        async () => {
          throw cleanupError;
        },
        onCleanupError,
      ),
    ).rejects.toBe(cleanupError);
    expect(onCleanupError).not.toHaveBeenCalled();
  });

  /**
   * `afterBody` words a failed cleanup after a body that did its work, from
   * what the body returned - the migrate entry points say what the run did
   * before the close - and only then: after a failed body the cleanup's
   * failure goes to the callback as it is.
   */
  it("throws the cleanup's failure as afterBody puts it, only after a body that succeeded", async () => {
    const cleanupError = new Error("write CONNECTION_ENDED");
    const worded = new Error("closing failed after the work was done");
    const afterBody = vi.fn(() => worded);
    const onCleanupError = vi.fn();
    const failingCleanup = async () => {
      throw cleanupError;
    };

    await expect(
      withCleanup(
        async () => "done",
        failingCleanup,
        onCleanupError,
        afterBody,
      ),
    ).rejects.toBe(worded);
    expect(afterBody).toHaveBeenCalledTimes(1);
    expect(afterBody).toHaveBeenCalledWith(cleanupError, "done");

    const cause = new Error("migration failed");
    await expect(
      withCleanup(
        async () => {
          throw cause;
        },
        failingCleanup,
        onCleanupError,
        afterBody,
      ),
    ).rejects.toBe(cause);
    expect(afterBody).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
  });
});
