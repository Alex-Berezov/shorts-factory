import { fork } from "node:child_process";
import { type Server, type Socket, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeRedis } from "../src/lib/redis.js";
import { openTestRedis } from "./helpers.int.js";

/**
 * The container healthcheck of the worker, run the way Compose runs it - a
 * separate `node --import tsx` process - against the test Redis and against a
 * port nothing listens on. A fake client could not show the one property that
 * matters for a dead Redis: that the process ends on its own, with 1, before
 * Docker's own timeout would have to kill it.
 */
const CLI = fileURLToPath(
  new URL("../src/cli/healthcheck.ts", import.meta.url),
);
/** A port nothing listens on; connecting is refused rather than hanging. */
const DEAD_REDIS = "redis://127.0.0.1:1";
/** The command's own deadline; Compose gives it 10 s (`timeout:`). */
const CLI_DEADLINE_MS = 5_000;
/** Room for starting node with tsx on a slow machine. */
const SPAWN_ALLOWANCE_MS = 5_000;

const redis = openTestRedis();

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  elapsedMs: number;
}

async function runHealthcheck(env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const startedAt = Date.now();
  const child = fork(CLI, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  return await new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, elapsedMs: Date.now() - startedAt });
    });
  });
}

beforeEach(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
});

afterAll(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
  await closeRedis(redis);
});

describe("worker healthcheck", () => {
  it("exits 0 on a fresh stamp", async () => {
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );

    const run = await runHealthcheck();

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^healthy: last heartbeat at /);
  });

  it("reads REDIS_URL alone: a malformed key it does not use changes nothing", async () => {
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );

    // Both fail the full configuration schema; neither is the healthcheck's.
    const run = await runHealthcheck({
      WORKER_CONCURRENCY: "lots",
      ADMIN_PASSWORD: "short",
    });

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^healthy: last heartbeat at /);
  });

  it("exits 1 with its own reason when REDIS_URL is not a url", async () => {
    const run = await runHealthcheck({ REDIS_URL: "not a url" });

    expect(run.code).toBe(1);
    expect(run.stdout.trim()).toMatch(/^unhealthy: REDIS_URL is not usable: /);
  });

  it("exits 1 on a stamp that is not a date", async () => {
    await redis.set(WORKER_HEARTBEAT_KEY, "yesterday-ish");

    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    expect(run.stdout.trim()).toBe("unhealthy: heartbeat stamp is not a date");
  });

  it("exits 1 when the stamp is missing", async () => {
    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    expect(run.stdout.trim()).toBe("unhealthy: no heartbeat stamp in redis");
  });

  it("exits 1 on a stamp older than the TTL", async () => {
    const old = new Date(
      Date.now() - (WORKER_HEARTBEAT_TTL_SEC + 60) * 1_000,
    ).toISOString();
    await redis.set(WORKER_HEARTBEAT_KEY, old);

    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    expect(run.stdout.trim()).toBe(`unhealthy: last heartbeat at ${old}`);
  });

  it(
    "exits 1 on its own, within its deadline, when redis is not there",
    async () => {
      const run = await runHealthcheck({ REDIS_URL: DEAD_REDIS });

      expect(run.signal).toBeNull();
      expect(run.code).toBe(1);
      expect(run.stdout.trim()).toMatch(/^unhealthy: /);
      expect(run.elapsedMs).toBeLessThan(CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS);
    },
    CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS + 10_000,
  );

  it(
    "exits 1 at its deadline when redis accepts the connection and never answers",
    async () => {
      // A real socket that swallows every byte: the connect succeeds, so no
      // connect timeout or refusal ends the wait - only the deadline does.
      const sockets: Socket[] = [];
      const silent: Server = createServer((socket) => {
        // The healthcheck leaves through `process.exit`, which resets the
        // connection rather than closing it; that reset is expected here.
        socket.on("error", () => undefined);
        sockets.push(socket);
      });
      await new Promise<void>((resolve) => {
        silent.listen(0, "127.0.0.1", resolve);
      });
      const address = silent.address();
      if (address === null || typeof address === "string") {
        throw new Error("silent redis has no tcp port");
      }

      try {
        const run = await runHealthcheck({
          REDIS_URL: `redis://127.0.0.1:${address.port}`,
        });

        expect(run.signal).toBeNull();
        expect(run.code).toBe(1);
        expect(run.stdout.trim()).toBe(
          `unhealthy: no answer from redis within ${CLI_DEADLINE_MS} ms`,
        );
        expect(run.elapsedMs).toBeGreaterThanOrEqual(CLI_DEADLINE_MS);
        expect(run.elapsedMs).toBeLessThan(
          CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS,
        );
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          silent.close(() => resolve());
        });
      }
    },
    CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS + 10_000,
  );
});
