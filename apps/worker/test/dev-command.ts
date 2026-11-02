import { fileURLToPath } from "node:url";
import {
  type DevCommandParts,
  devCommandParts as devCommandPartsOf,
  manifestScripts as manifestScriptsOf,
} from "@sf/runtime/test-support/dev-command";

/**
 * How the worker process is started - by `pnpm dev`, by the container image
 * (target `worker` of infra/docker/app.Dockerfile) and by the signal fixture of
 * `entry-point.int.test.ts`. One literal for all three checks: node itself as
 * the process that receives the signal, with `tsx` as a loader rather than as
 * a parent (docs/DECISIONS.md, 10.09.2026). The image is held to `scripts.dev`
 * of the manifest by the root project (`test/container.test.ts`), the
 * manifest to this literal by `dev-command.test.ts`.
 */
export const DEV_COMMAND = "node --import tsx src/index.ts";

/** The directory of this package. */
export const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The scripts of this package's manifest, by name. */
export function manifestScripts(): Record<string, string> {
  return manifestScriptsOf(PACKAGE_DIR);
}

/** `DEV_COMMAND` taken apart for `fork` (`devCommandParts` of the runtime). */
export function devCommandParts(): DevCommandParts {
  return devCommandPartsOf(DEV_COMMAND);
}
