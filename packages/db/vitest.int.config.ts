import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    setupFiles: ["@sf/config/vitest/setup"],
    testTimeout: 15_000,
  },
});
