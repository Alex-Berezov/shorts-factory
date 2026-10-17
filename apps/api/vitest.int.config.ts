import { intTestConfig } from "../../vitest.preset.js";

/**
 * Integration run of the api (`pnpm --filter @sf/api test:int`): its files
 * share the test database and Redis database 2, which is why the preset runs
 * them one at a time.
 */
export default intTestConfig({
  setupFiles: ["@sf/config/vitest/setup"],
  entryCheck: "migrated-stack",
  testTimeout: 15_000,
});
