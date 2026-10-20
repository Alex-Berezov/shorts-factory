import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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

const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const ManifestSchema = z.object({ scripts: z.record(z.string()) });

/** The scripts of this package's manifest, by name. */
export function manifestScripts(): Record<string, string> {
  return ManifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")))
    .scripts;
}

/** What `fork` takes to start a process the way `DEV_COMMAND` does. */
export interface DevCommandParts {
  /** The flags of node itself, before the script. */
  execArgv: string[];
  /** The script, relative to the package directory. */
  script: string;
}

/**
 * `DEV_COMMAND` taken apart for `fork`, so a test that starts the entry point
 * starts it with the command `pnpm dev` runs rather than a copy of it. The
 * command is node, its flags and one script - anything else is a command this
 * cannot reproduce, and is refused rather than guessed at. `command` is
 * there for the test of that refusal; every other caller takes the default.
 */
export function devCommandParts(command = DEV_COMMAND): DevCommandParts {
  const [runtime, ...rest] = command.split(" ");
  const script = rest.pop();
  if (runtime !== "node" || script === undefined || script.startsWith("-")) {
    throw new Error(`not a node command with a script: ${command}`);
  }
  return { execArgv: rest, script };
}

/**
 * Whether `script` may start a process under a watcher - a parent that
 * restarts it on a change and owns its signals: any script that has `watch`
 * in it, in any case (`tsx watch`, `--watch`, `watchexec`, `vitest --watch`);
 * a watcher whose command lacks the word (`nodemon`) is not caught. No list of watchers and no exceptions:
 * a list misses the next wrapper, and a script that only looks like one is
 * cheaper to rename than a watcher is to notice.
 */
export function isWatcherCommand(script: string): boolean {
  return /watch/i.test(script);
}
