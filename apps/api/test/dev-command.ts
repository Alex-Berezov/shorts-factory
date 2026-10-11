/**
 * How `pnpm dev` starts the api: node itself as the process that receives the
 * signal, with `tsx` as a loader rather than as a parent (docs/DECISIONS.md,
 * Р8 E0-11A) - the same rule the worker follows
 * (`apps/worker/test/dev-command.ts`). The manifest is held to it here; that
 * the container image runs the same command is checked against the manifest
 * itself by `apps/worker/test/container.test.ts`, so changing this literal and
 * `scripts.dev` together still leaves the image to agree with them.
 */
export const DEV_COMMAND = "node --import tsx src/server.ts";

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
 * cannot reproduce, and is refused rather than guessed at.
 */
export function devCommandParts(): DevCommandParts {
  const [runtime, ...rest] = DEV_COMMAND.split(" ");
  const script = rest.pop();
  if (runtime !== "node" || script === undefined || script.startsWith("-")) {
    throw new Error(`not a node command with a script: ${DEV_COMMAND}`);
  }
  return { execArgv: rest, script };
}
