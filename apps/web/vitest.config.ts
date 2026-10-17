import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import { unitTestConfig } from "../../vitest.preset.js";

// Tests in test/ only - the reason is at `testDirs` in the preset.
export default mergeConfig(unitTestConfig({ testDirs: ["test"] }), {
  resolve: {
    // The `@/*` path of tsconfig.json, which Next resolves on its own.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig keeps JSX for Next to compile (`preserve`); a component called
  // from a test needs it compiled the way Next does, without `import React`.
  esbuild: { jsx: "automatic" },
});
