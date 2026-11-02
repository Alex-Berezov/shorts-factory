import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  devCommandParts,
  isWatcherCommand,
  manifestScripts,
  watcherScripts,
} from "../test-support/dev-command.js";
import { packageWith, removePackageDirs } from "./package-fixture.js";

describe("manifestScripts", () => {
  afterEach(removePackageDirs);

  it("reads the scripts of the manifest in the directory it is given", () => {
    const dir = packageWith(
      JSON.stringify({ name: "x", scripts: { dev: "node src/index.ts" } }),
    );

    expect(manifestScripts(dir)).toEqual({ dev: "node src/index.ts" });
  });

  it.each([
    ["without scripts", JSON.stringify({ name: "x" })],
    [
      "with a script that is no string",
      JSON.stringify({ scripts: { dev: 1 } }),
    ],
  ])("refuses a manifest %s, naming the file", (_case, text) => {
    const dir = packageWith(text);

    expect(() => manifestScripts(dir)).toThrow(join(dir, "package.json"));
  });
});

describe("devCommandParts", () => {
  it("takes a dev command apart into the flags of node and the script", () => {
    expect(devCommandParts("node --import tsx src/index.ts")).toEqual({
      execArgv: ["--import", "tsx"],
      script: "src/index.ts",
    });
  });

  it.each([
    ["is not node", "tsx src/server.ts"],
    ["ends in a flag", "node --import tsx --watch"],
    ["has no script", "node"],
    ["has two spaces in a row", "node --import  tsx src/index.ts"],
    ["sets a part off by a tab", "node --import	tsx src/index.ts"],
    ["starts with a space", " node src/index.ts"],
    ["ends in a space", "node src/index.ts "],
  ])("refuses a command that %s", (_case, command) => {
    expect(() => devCommandParts(command)).toThrow(
      `not a node command with a script: ${command}`,
    );
  });
});

describe("watcherScripts", () => {
  it("names a watcher in a script other than dev", () => {
    expect(
      watcherScripts({
        dev: "node --import tsx src/server.ts",
        start: "tsx watch src/server.ts",
      }),
    ).toEqual(["start"]);
  });
});

describe("isWatcherCommand", () => {
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
