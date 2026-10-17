import { type ChildProcess, fork } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@sf/config";
import { SystemStatusResponseSchema } from "@sf/contracts";
import {
  TEST_REDIS_DATABASE_OF,
  suiteRedisUrl,
} from "@sf/db/test-support/stack-guard";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devCommandParts } from "./dev-command.js";
import { openTestRedis } from "./helpers.int.js";
import { basicAuthHeader } from "./helpers.js";

/**
 * The entry point itself, against the stack of `infra/docker-compose.yml`:
 * the entry point started with the command `pnpm dev` runs (`DEV_COMMAND`,
 * taken apart by `devCommandParts`), with one build label that is a label and
 * one that is not. What only the entry point does - reading
 * which labels the config dropped (`rejectedBuildLabels()`) and handing the
 * parsed config to `composeApp`, which turns it into the fingerprint of
 * `/system/status` - is seen from the outside: in the log of the process and
 * in the page.
 */
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const VERSION = "1.4.0";
/** Not a build label: a space and a bracket are outside `BUILD_LABEL`. */
const REJECTED_COMMIT = "abc1234 (dirty)";
/** How long the process may take to come up and answer. */
const START_DEADLINE_MS = 10_000;

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("the port probe is not listening on a tcp port");
  }
  return address.port;
}

/** Asks the page until the process answers it or the deadline passes. */
async function statusOf(port: number): Promise<unknown> {
  const deadline = Date.now() + START_DEADLINE_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/system/status`, {
        headers: { authorization: basicAuthHeader(env.ADMIN_PASSWORD) },
      });
      expect(res.status).toBe(200);
      return await res.json();
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("api entry point", () => {
  let child: ChildProcess;
  let output = "";
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    const { execArgv, script } = devCommandParts();
    child = fork(join(APP_DIR, script), [], {
      cwd: APP_DIR,
      execArgv,
      // The config of the test run (`.env.test`, loaded by the vitest setup)
      // with the two labels and the port of this case on top, and the Redis
      // database of the api suite instead of the one the worker suite uses.
      env: {
        ...process.env,
        REDIS_URL: suiteRedisUrl(env.REDIS_URL, "api"),
        API_PORT: String(port),
        APP_VERSION: VERSION,
        GIT_COMMIT: REJECTED_COMMIT,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  });

  afterAll(async () => {
    if (child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.on("exit", () => {
        resolve();
      });
    });
    child.kill();
    await exited;
  });

  it("reports the label it was given and null for the one it dropped", async () => {
    const status = SystemStatusResponseSchema.parse(await statusOf(port));

    expect(status.build).toEqual({ version: VERSION, commit: null });
  });

  it("names the dropped label in its log, without the value", async () => {
    await statusOf(port);
    const warnings = output
      .split("\n")
      .filter((line) => line.includes("build label ignored"))
      .map((line): Record<string, unknown> => JSON.parse(line));

    expect(warnings).toEqual([
      expect.objectContaining({ level: 40, variable: "GIT_COMMIT" }),
    ]);
    expect(output).not.toContain(REJECTED_COMMIT);
  });

  it("keeps its Redis connections out of the database of the worker suite", async () => {
    await statusOf(port);
    const redis = openTestRedis();
    try {
      // No offline queue: a command before the socket is up is refused.
      if (redis.status !== "ready") {
        await new Promise<void>((resolve) => {
          redis.once("ready", () => {
            resolve();
          });
        });
      }
      const clients = String(await redis.client("LIST"));

      expect(clients).not.toMatch(
        new RegExp(`\\bdb=${TEST_REDIS_DATABASE_OF.worker}\\b`),
      );
    } finally {
      redis.disconnect();
    }
  });
});
