import { type EnvLike, VITEST_MARKER } from "../src/env-file.js";

/**
 * Guards against importing the fixture outside a vitest worker: it mutates
 * `process.env` unconditionally, which must never happen at runtime. The
 * marker is the shared one, so the runtime gate in `bootstrapEnv` and this
 * check can never drift apart.
 */
export function assertVitestRun(env: EnvLike): void {
  if (env.VITEST !== VITEST_MARKER) {
    throw new Error(
      "@sf/config/vitest/setup is a vitest setupFile and must not be imported at runtime",
    );
  }
}
