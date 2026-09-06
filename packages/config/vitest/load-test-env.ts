import { parseEnv } from "node:util";

/** Minimal shape both functions below operate on - a mutable string map. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Guards against importing this module outside a vitest worker: it mutates
 * `process.env` unconditionally, which must never happen at runtime. Vitest
 * sets `VITEST=true` in every worker before `setupFiles` run.
 */
export function assertVitestRun(env: EnvLike): void {
  if (env.VITEST !== "true") {
    throw new Error(
      "@sf/config/vitest/setup is a vitest setupFile and must not be imported at runtime",
    );
  }
}

/**
 * Purges the given schema keys from `target`, then applies the fixture on
 * top. Deleting first (rather than a plain `Object.assign`) guarantees the
 * fixture wins even for keys the fixture itself does not set - otherwise a
 * leaked shell value for a key absent from the fixture (for example a real
 * `GEMINI_API_KEY`) would survive untouched.
 */
export function loadTestEnv(
  fixtureText: string,
  target: EnvLike,
  keys: readonly string[],
): void {
  for (const key of keys) {
    delete target[key];
  }
  Object.assign(target, parseEnv(fixtureText));
}
