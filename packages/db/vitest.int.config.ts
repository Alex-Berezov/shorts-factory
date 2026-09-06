import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    setupFiles: ["../config/vitest/setup.ts"],
    testTimeout: 15_000,
  },
});
