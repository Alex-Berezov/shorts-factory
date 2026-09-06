import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
    setupFiles: ["../config/vitest/setup.ts"],
  },
});
