import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    setupFiles: ["@sf/config/vitest/setup"],
    testTimeout: 15_000,
    // Every file resets the same test database, so two workers would drop the
    // schema under each other.
    fileParallelism: false,
  },
});
