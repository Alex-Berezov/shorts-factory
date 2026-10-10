import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The `@/*` path of tsconfig.json, which Next resolves on its own.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig keeps JSX for Next to compile (`preserve`); a component called
  // from a test needs it compiled the way Next does, without `import React`.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
  },
});
