import { describe, expect, it } from "vitest";
import {
  DEV_COMMAND,
  devCommandParts,
  isWatcherCommand,
  manifestScripts,
} from "./dev-command.js";

/**
 * `pnpm dev` starts the api the way the container does: node itself owns
 * Ctrl+C and closes Fastify, the database and Redis before it exits. Under
 * `tsx watch` the signal went to a parent that kills the child after five
 * seconds - on Windows at once - and requests in flight were cut off with no
 * `shutdown complete` in the log. The image side of the same command is
 * checked by `test/container.test.ts` of the root project, whose hash
 * (`//#test:repo`) covers every tracked file of the repository.
 */
describe("api dev command", () => {
  const scripts = manifestScripts();

  it("is node with tsx as a loader", () => {
    expect(scripts.dev).toBe(DEV_COMMAND);
  });

  it("is taken apart for a test into the flags of node and the script", () => {
    // `entry-point.int.test.ts` forks the entry point from these, so what it
    // proves is the command `pnpm dev` runs.
    expect(devCommandParts()).toEqual({
      execArgv: ["--import", "tsx"],
      script: "src/server.ts",
    });
  });

  it.each([
    ["is not node", "tsx src/server.ts"],
    ["ends in a flag", "node --import tsx --watch"],
    ["has no script", "node"],
  ])("refuses a command that %s", (_case, command) => {
    expect(() => devCommandParts(command)).toThrow(
      `not a node command with a script: ${command}`,
    );
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
