import { intTestConfig } from "../../vitest.preset.js";

/**
 * Integration run of `@sf/db`: every file resets the same test database, which
 * is why the preset runs the files one at a time.
 */
export default intTestConfig({
  setupFiles: ["@sf/config/vitest/setup"],
  entryCheck: "postgres",
  testTimeout: 15_000,
});
