import { fileURLToPath } from "node:url";
import {
  type DevCommandParts,
  devCommandParts as devCommandPartsOf,
  manifestScripts as manifestScriptsOf,
} from "@sf/runtime/test-support/dev-command";

/**
 * How `pnpm dev` starts the api: node itself as the process that receives the
 * signal, with `tsx` as a loader rather than as a parent (docs/DECISIONS.md,
 * Р8 E0-11A) - the same rule the worker follows
 * (`apps/worker/test/dev-command.ts`). The manifest is held to it here; that
 * the container image runs the same command is checked against the manifest
 * itself by `test/container.test.ts` of the root project, so changing this
 * literal and `scripts.dev` together still leaves the image to agree with them.
 */
export const DEV_COMMAND = "node --import tsx src/server.ts";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The scripts of this package's manifest, by name. */
export function manifestScripts(): Record<string, string> {
  return manifestScriptsOf(PACKAGE_DIR);
}

/** `DEV_COMMAND` taken apart for `fork` (`devCommandParts` of the runtime). */
export function devCommandParts(): DevCommandParts {
  return devCommandPartsOf(DEV_COMMAND);
}
