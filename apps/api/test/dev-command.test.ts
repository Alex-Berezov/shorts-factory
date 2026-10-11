import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEV_COMMAND, devCommandParts } from "./dev-command.js";

const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const ManifestSchema = z.object({ scripts: z.record(z.string()) });

/**
 * `pnpm dev` starts the api the way the container does: node itself owns
 * Ctrl+C and closes Fastify, the database and Redis before it exits. Under
 * `tsx watch` the signal went to a parent that kills the child after five
 * seconds - on Windows at once - and requests in flight were cut off with no
 * `shutdown complete` in the log. The image side of the same command is
 * checked by `apps/worker/test/container.test.ts`, which has
 * `infra/docker/**` among its inputs.
 */
describe("api dev command", () => {
  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(MANIFEST, "utf8")),
  );

  it("is node with tsx as a loader", () => {
    expect(manifest.scripts.dev).toBe(DEV_COMMAND);
  });

  it("is taken apart for a test into the flags of node and the script", () => {
    // `entry-point.int.test.ts` forks the entry point from these, so what it
    // proves is the command `pnpm dev` runs.
    expect(devCommandParts()).toEqual({
      execArgv: ["--import", "tsx"],
      script: "src/server.ts",
    });
  });

  it("has no watcher variant to reach for instead", () => {
    expect(Object.keys(manifest.scripts)).not.toContain("dev:watch");
    expect(Object.values(manifest.scripts).join(" ")).not.toContain("watch");
  });
});
