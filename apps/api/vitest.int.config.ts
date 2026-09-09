import { defineConfig } from "vitest/config";

/**
 * Integration run: the same tests only make sense against the Postgres and
 * Redis of `infra/docker-compose.yml`, so they are kept out of `pnpm test`
 * and asked for explicitly (`pnpm --filter @sf/api test:int`). A stack that is
 * not up makes this run red - the point is to notice.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    setupFiles: ["@sf/config/vitest/setup"],
    testTimeout: 15_000,
  },
});
