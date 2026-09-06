import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Filesystem anchors of the workspace, resolved from this module and never
 * from `cwd`: turbo and pnpm start tasks in the package directory, so a `cwd`
 * lookup would miss the root files. Every other module takes the paths from
 * here - a second copy of the `../../../` arithmetic silently rots when the
 * package moves. The root is composed with `path`, not with
 * `new URL("../../../", import.meta.url)`: webpack reads the latter as an asset
 * reference and fails the bundle with `Can't resolve '../../../'`.
 */
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * The single env file the runtime reads. No cascade (`.env.local`,
 * `.env.${NODE_ENV}`) on purpose.
 */
export const rootEnvFilePath = join(repoRoot, ".env");

/** Committed test fixture loaded by `@sf/config/vitest/setup`. */
export const testEnvFilePath = join(repoRoot, ".env.test");
