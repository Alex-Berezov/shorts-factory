import { defineConfig } from "vitest/config";

/**
 * Integration run: these tests only mean anything against the Postgres and
 * Redis of `infra/docker-compose.yml`, so they are kept out of `pnpm test` and
 * asked for explicitly (`pnpm --filter @sf/worker test:int`). A stack that is
 * not up makes this run red - the point is to notice.
 *
 * They also need the schema and the seed: `pnpm db:migrate` and `pnpm db:seed`
 * against `.env.test`, because a worker refuses to start without the queue
 * switches.
 *
 * `fileParallelism: false`: every file drives a real BullMQ queue in the same
 * Redis database, and two files running at once would take each other's jobs.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    setupFiles: ["@sf/config/vitest/setup"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
