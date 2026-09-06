import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { rootEnvFilePath } from "./paths.js";

/** Minimal shape the loader operates on - a mutable string map. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Value vitest puts in `VITEST` in every worker before `setupFiles` run. Both
 * sides of the package ask about it - the runtime skips the root `.env` under
 * tests, the fixture refuses to run anywhere else - and a marker spelled twice
 * can be changed once: the fixture would keep working while `bootstrapEnv`
 * silently started reading a developer's `.env` again.
 */
export const VITEST_MARKER = "true";

/**
 * The single definition of "set" for the whole package. An empty or blank
 * value is not a value: `TOKEN_ENCRYPTION_KEY=` in a file and `KEY=` from a
 * compose file with an unset host variable both mean "not configured".
 * Both halves of the loader ask this question - the merge below and
 * `normalizeValues` in `load-env.ts` - because a disagreement between them
 * lets an empty process variable shadow a real value from the file and then be
 * dropped, leaving the config silently unset.
 */
export function isEnvValueSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Reads an env file as text. A missing file is a distinct outcome, not an
 * error: `.env` is optional at runtime. Any other failure (permissions, a
 * directory in place of the file) is rethrown - staying silent there would
 * hide a broken deployment behind default values.
 */
export function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Runtime mode: the file only fills keys the target leaves unset, so
 * container and shell variables win over the checked-out `.env`. Takes no key
 * list - the whole file is applied, and validation is `loadEnv`'s job.
 */
export function mergeEnvFile(text: string, target: EnvLike): void {
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (isEnvValueSet(value) && !isEnvValueSet(target[key])) {
      target[key] = value;
    }
  }
}

/**
 * Test fixture mode: every key of `keys` is deleted from the target first, so
 * the fixture wins even for keys it does not set itself. Without the purge a
 * leaked shell value for a key absent from the fixture (a real
 * `GEMINI_API_KEY`, for one) would survive into the test run.
 */
export function overrideEnvFile(
  text: string,
  target: EnvLike,
  keys: readonly string[],
): void {
  for (const key of keys) {
    delete target[key];
  }
  Object.assign(target, parseEnv(text));
}

/**
 * Fills `target` from the repository root `.env` the way the runtime does it.
 *
 * Under vitest the file is not read at all: the fixture in
 * `@sf/config/vitest/setup` purges schema keys from `process.env`, and a
 * developer's local `.env` would refill them with live credentials - exactly
 * the defect E0-02 closed. The marker is read from `target`, not from
 * `process.env`, so the gate itself is testable.
 */
export function bootstrapEnv(
  target: EnvLike,
  path: string = rootEnvFilePath,
): void {
  if (target.VITEST === VITEST_MARKER) {
    return;
  }

  const text = readEnvFile(path);
  if (text === undefined) {
    return;
  }

  mergeEnvFile(text, target);
}
