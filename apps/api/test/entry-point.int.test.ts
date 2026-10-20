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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { devCommandParts } from "./dev-command.js";
import { openTestRedis, whenReady } from "./helpers.int.js";
import { basicAuthHeader } from "./helpers.js";

/**
 * The entry point itself, against the stack of `infra/docker-compose.yml`:
 * the entry point started with the command `pnpm dev` runs (`DEV_COMMAND`,
 * taken apart by `devCommandParts`), with one build label that is a label and
 * one that is not. What only the entry point does - reading
 * which labels the config dropped (`rejectedBuildLabels`) and handing the
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

/** `id` and `db` of each client `CLIENT LIST` names. */
function clientsOf(list: string): { id: number; db: string }[] {
  return list
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      id: Number(/\bid=(\d+)/.exec(line)?.[1] ?? Number.NaN),
      db: /\bdb=(\d+)/.exec(line)?.[1] ?? "",
    }));
}

/** The id the server gives the next client: one past the newest so far. */
async function nextClientId(): Promise<number> {
  const redis = openTestRedis();
  try {
    await whenReady(redis);
    return Number(await redis.client("ID")) + 1;
  } finally {
    redis.disconnect();
  }
}

/** How long the server may take to drop the connections of a dead process. */
const CONNECTIONS_GONE_DEADLINE_MS = 5_000;

/** Stops a child and waits for its end; a child already ended is left be. */
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });
  child.kill();
  await exited;
}

describe("api entry point", () => {
  let child: ChildProcess;
  let output = "";
  let port: number;
  /**
   * Client ids are handed out in order: every client from here on is the
   * fork's or one of this file's, and a client left by another run - a
   * worker fork of a crashed run, in its own database - is older.
   */
  let firstForkClientId: number;

  beforeAll(async () => {
    firstForkClientId = await nextClientId();
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
    await stopped(child);
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
      await whenReady(redis);
      // Every client between the fork's start and this one is a connection
      // the fork opened - this file opens none in between.
      const own = Number(await redis.client("ID"));
      const forked = clientsOf(String(await redis.client("LIST"))).filter(
        (client) => client.id >= firstForkClientId && client.id < own,
      );

      // The fork has a connection open by now (it answered the page), and
      // every one of them sits in the api's database.
      expect(forked.length).toBeGreaterThan(0);
      expect(forked.map((client) => client.db)).toEqual(
        forked.map(() => TEST_REDIS_DATABASE_OF.api),
      );

      // And they are the fork's, not some other client's of the window: they
      // leave with it.
      await stopped(child);
      const forkedIds = new Set(forked.map((client) => client.id));
      await vi.waitFor(
        async () => {
          const left = clientsOf(String(await redis.client("LIST"))).filter(
            (client) => forkedIds.has(client.id),
          );
          expect(left).toEqual([]);
        },
        { timeout: CONNECTIONS_GONE_DEADLINE_MS, interval: 50 },
      );
    } finally {
      redis.disconnect();
    }
  });
});

/**
 * How long the process on a taken port gets to leave: its start, the stop
 * with its own deadline of ten seconds, and the flush of the log after it.
 */
const EXIT_DEADLINE_MS = 20_000;

/** The exit code of a child, or a failure once `EXIT_DEADLINE_MS` passes. */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the api did not exit within ${EXIT_DEADLINE_MS}ms`));
    }, EXIT_DEADLINE_MS);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

describe("api entry point on a port that is taken", () => {
  /**
   * The connections are open by the time `listen` fails: the stop closes
   * them the way a signal would and leaves with the code of a failure, rather
   * than a bare `process.exit(1)` past everything it opened.
   */
  it(
    "closes what it opened through the stop and exits with 1",
    async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => {
        taken.listen(0, "0.0.0.0", resolve);
      });
      const address = taken.address();
      if (address === null || typeof address === "string") {
        throw new Error("the port holder is not listening on a tcp port");
      }
      let child: ChildProcess | undefined;
      try {
        const { execArgv, script } = devCommandParts();
        child = fork(join(APP_DIR, script), [], {
          cwd: APP_DIR,
          execArgv,
          env: {
            ...process.env,
            REDIS_URL: suiteRedisUrl(env.REDIS_URL, "api"),
            API_PORT: String(address.port),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const code = await exitOf(child);

        expect(code).toBe(1);
        const lines = output
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line): Record<string, unknown> => JSON.parse(line));
        expect(lines.map((line) => line.msg)).toEqual(
          expect.arrayContaining([
            "failed to start the api",
            "shutdown started",
            "shutdown complete",
          ]),
        );
        expect(
          lines.find((line) => line.msg === "shutdown complete"),
        ).toMatchObject({ signal: "listen failure", failed: true });
        // Redis may not be connected yet when the port is refused: torn down
        // instead of a QUIT, it writes "closed by disconnect" - closed all the same.
        expect(
          lines
            .filter(
              (line) =>
                line.msg === "closed" || line.msg === "closed by disconnect",
            )
            .map((line) => line.target),
        ).toEqual(expect.arrayContaining(["app", "db", "queues", "redis"]));
      } finally {
        // A process that did not leave on its own - a failed assertion, a
        // stop that hung - does not outlive the case.
        if (child !== undefined) {
          await stopped(child);
        }
        await new Promise<void>((resolve) => {
          taken.close(() => {
            resolve();
          });
        });
      }
    },
    EXIT_DEADLINE_MS + 5_000,
  );
});
