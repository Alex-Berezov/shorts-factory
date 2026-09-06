import { fileURLToPath } from "node:url";

/**
 * Loads the repo-root `.env.test` before any package under test imports
 * `@sf/config` (which parses `process.env` eagerly on import).
 * Referenced by path from each package's `vitest.config.ts` `setupFiles`
 * (never imported as `@sf/config/vitest/setup`) - see docs/30_E0_TASKS.md § E0-02.
 */
const envTestPath = fileURLToPath(
  new URL("../../../.env.test", import.meta.url),
);
process.loadEnvFile(envTestPath);
