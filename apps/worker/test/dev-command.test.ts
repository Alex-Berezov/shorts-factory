import { describe, expect, it } from "vitest";
import {
  DEV_COMMAND,
  isWatcherCommand,
  manifestScripts,
} from "./dev-command.js";

/**
 * `pnpm dev` starts the worker with the command the signal test
 * (`entry-point.int.test.ts`) proves the drain for: node itself owns the
 * signal, `tsx` is a loader. The image side of the same command is checked
 * against the manifest by the root project (`test/container.test.ts`), so the
 * image, `scripts.dev` and this literal agree in two links.
 */
describe("worker dev command", () => {
  const scripts = manifestScripts();

  it("is node with tsx as a loader", () => {
    expect(scripts.dev).toBe(DEV_COMMAND);
  });

  it("starts nothing under a watcher, in any script", () => {
    expect(Object.keys(scripts)).not.toContain("dev:watch");
    expect(watcherScripts(scripts)).toEqual([]);
  });

  it("refuses a watcher in a script other than dev", () => {
    expect(
      watcherScripts({ ...scripts, start: "tsx watch src/server.ts" }),
    ).toEqual(["start"]);
  });

  it.each([
    ["tsx watch src/index.ts", true],
    ["tsx --watch src/index.ts", true],
    ["node --watch src/index.ts", true],
    ["node --import tsx --watch-path=src src/index.ts", true],
    ["turbo watch dev", true],
    ["bun --watch src/index.ts", true],
    ["watchexec -- node src/index.ts", true],
    ["tsx --flag watch src/index.ts", true],
    ["TSX WATCH src/index.ts", true],
    ["vitest --watch", true],
    ["tsx src/cli/watchlist.ts", true],
    ["node --import tsx src/index.ts", false],
  ])("takes %j for a watcher: %s", (script, watcher) => {
    expect(isWatcherCommand(script)).toBe(watcher);
  });
});

/** The names of the scripts that start a process under a watcher. */
function watcherScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, script]) => isWatcherCommand(script))
    .map(([name]) => name);
}
