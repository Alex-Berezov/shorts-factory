import { z } from "zod";
import { readPackageManifest } from "./manifest.js";

/**
 * The command `pnpm dev` of an app runs, as the tests of the api and the
 * worker read it: the manifest and its scripts, the command taken apart for
 * `fork`, and what counts as a watcher. Each app keeps only its own literal
 * (`DEV_COMMAND` of `apps/<app>/test/dev-command.ts`) and binds these to it
 * and to its own directory (ADR-0011, "test-support of the apps").
 */

/** The part of a manifest `manifestScripts` reads. */
const ScriptsSchema = z.object({ scripts: z.record(z.string()) });

/**
 * The scripts of the manifest in `packageDir`, by name. A manifest without
 * them, or with a script that is no string, is refused with the path of the
 * file (`readPackageManifest`).
 */
export function manifestScripts(packageDir: string): Record<string, string> {
  return readPackageManifest(packageDir, ScriptsSchema).scripts;
}

/** What `fork` takes to start a process the way a dev command does. */
export interface DevCommandParts {
  /** The flags of node itself, before the script. */
  execArgv: string[];
  /** The script, relative to the package directory. */
  script: string;
}

/**
 * `command` taken apart for `fork`, so a test that starts an entry point
 * starts it with the command `pnpm dev` runs rather than a copy of it. The
 * command is node, its flags and one script, each part set off by one space -
 * anything else is a command this cannot reproduce, and is refused rather
 * than guessed at: a doubled space or a tab would be an empty or a joined
 * flag of node, which fails the start with a reason far from the command.
 */
export function devCommandParts(command: string): DevCommandParts {
  const parts = command.split(" ");
  const [runtime, ...rest] = parts;
  const script = rest.pop();
  if (
    parts.some((part) => part === "" || /\s/.test(part)) ||
    runtime !== "node" ||
    script === undefined ||
    script.startsWith("-")
  ) {
    throw new Error(`not a node command with a script: ${command}`);
  }
  return { execArgv: rest, script };
}

/**
 * Whether `script` may start a process under a watcher - a parent that
 * restarts it on a change and owns its signals: any script that has `watch`
 * in it, in any case (`tsx watch`, `--watch`, `watchexec`, `vitest --watch`);
 * a watcher whose command lacks the word (`nodemon`) is not caught. No list of
 * watchers and no exceptions: a list misses the next wrapper, and a script
 * that only looks like one is cheaper to rename than a watcher is to notice.
 */
export function isWatcherCommand(script: string): boolean {
  return /watch/i.test(script);
}

/** The names of the scripts that start a process under a watcher. */
export function watcherScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, script]) => isWatcherCommand(script))
    .map(([name]) => name);
}
