import { watcherScripts } from "@sf/runtime/test-support/dev-command";
import { describe, expect, it } from "vitest";
import {
  DEV_COMMAND,
  devCommandParts,
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

  it("is taken apart for a test into the flags of node and the script", () => {
    // `entry-point.int.test.ts` forks the entry point from these, so what it
    // proves is the command `pnpm dev` runs.
    expect(devCommandParts()).toEqual({
      execArgv: ["--import", "tsx"],
      script: "src/index.ts",
    });
  });

  it("starts nothing under a watcher, in any script", () => {
    expect(Object.keys(scripts)).not.toContain("dev:watch");
    expect(watcherScripts(scripts)).toEqual([]);
  });
});
