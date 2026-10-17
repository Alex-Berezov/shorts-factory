import { intTestConfig } from "../../vitest.preset.js";

/**
 * Integration run of the worker (`pnpm --filter @sf/worker test:int`).
 *
 * The files need the schema and the seed: `pnpm db:migrate` and
 * `pnpm db:seed` against `.env.test`, because a worker refuses to start
 * without the queue switches. Every file drives a real BullMQ queue in the
 * same Redis database, which is why the preset runs them one at a time.
 */
export default intTestConfig({
  setupFiles: ["@sf/config/vitest/setup"],
  entryCheck: "migrated-stack",
  testTimeout: 30_000,
  hookTimeout: 30_000,
});
