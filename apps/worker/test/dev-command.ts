import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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

const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const ManifestSchema = z.object({ scripts: z.record(z.string()) });

/** The scripts of this package's manifest, by name. */
export function manifestScripts(): Record<string, string> {
  return ManifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")))
    .scripts;
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
