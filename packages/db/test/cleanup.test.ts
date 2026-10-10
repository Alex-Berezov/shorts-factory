import { describe, expect, it, vi } from "vitest";
import { withCleanup } from "../src/cleanup.js";

/**
 * The one "which failure is thrown" policy of `@sf/db`: the migration lock,
 * `runMigrations` and the CLI entry points all go through it.
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
});
