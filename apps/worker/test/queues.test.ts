import { QUEUE_NAMES } from "@sf/core";
import { describe, expect, it, vi } from "vitest";

/**
 * The worker has no queue list of its own: names come from the registry in
 * `@sf/core`, which `@sf/db` also seeds into `app_setting.queues.enabled`.
 * A second copy here would drift from the seed silently, so this canary reads
 * what the entry point reports and compares it with the registry.
 */
describe("worker queue registry", () => {
  it("reports every queue of the shared registry", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await import("../src/index.js");

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(`queues=${QUEUE_NAMES.length} registered`),
      );
    } finally {
      logged.mockRestore();
    }
  });
});
