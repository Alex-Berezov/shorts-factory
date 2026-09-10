import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeDb } from "@sf/db";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { systemSmokeJob } from "../src/jobs/system-smoke.js";
import { closeRedis } from "../src/lib/redis.js";
import {
  deleteSmokeUsage,
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  waitFor,
} from "./helpers.int.js";

/**
 * The DoD of E0-08 as a run: a real worker process, started the way
 * `pnpm --filter @sf/worker dev` starts it, gets a signal while it has work,
 * and has to stop without losing it.
 *
 * What the child does that a parent cannot: raise the signal. On Windows
 * `process.kill(pid, "SIGINT")` ends the target outright - `TerminateProcess`,
 * no handler - and a console Ctrl+C cannot be sent to a process in another
 * process group. So the fixture raises SIGINT inside the child, which is what
 * libuv does when a console delivers one; the subscription, the order of the
 * stages and the exit code are the production path from there on.
 *
 * "The way `pnpm dev` starts it" is asserted below rather than claimed here:
 * the fixture runs under `node --import tsx`, and so must the script, because
 * a watcher in front of the process takes the signal for itself. `tsx watch`
 * relays it with `child.kill(signal)` and follows with SIGKILL five seconds
 * later - on Windows that first call is already `TerminateProcess`, so nothing
 * below would run at all in the command the DoD names.
 */
const QUEUES = ["system.smoke", "system.dlq", "system.heartbeat"] as const;
const ENTRY = fileURLToPath(
  new URL("./fixtures/entry-under-signal.ts", import.meta.url),
);
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
/** How the worker is started: by `pnpm dev`, by the image of E0-11 and here. */
const DEV_COMMAND = "node --import tsx src/index.ts";
const ManifestSchema = z.object({ scripts: z.object({ dev: z.string() }) });
/** Enough jobs that the worker is busy when the signal arrives. */
const JOB_COUNT = 30;

const db = openTestDb();
const redis = openTestRedis();
const smoke = new Queue("system.smoke", { connection: redis });

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

/** Starts the worker, waits until it is up, signals it and waits for the end. */
async function runUnderSignal(): Promise<Run> {
  const child = fork(ENTRY, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const ended = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the worker never started; it said: ${stdout}`));
    }, 25_000);
    child.on("message", (message: unknown) => {
      if (message === "started") {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  for (let index = 0; index < JOB_COUNT; index += 1) {
    await systemSmokeJob.enqueue(smoke, { requestedAtMs: Date.now() + index });
  }
  await waitFor(
    async () => ((await smoke.getActiveCount()) > 0 ? true : undefined),
    { what: "the worker to pick a job up" },
  );

  child.send("signal");
  return await ended;
}

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db);
  await deleteSmokeUsage(db);
});

afterAll(async () => {
  await smoke.close();
  await obliterateQueues(redis, QUEUES);
  await deleteSmokeUsage(db);
  await closeDb(db);
  await closeRedis(redis);
});

describe("worker entry point under a signal", () => {
  it("stops in order, keeps the job it was running and leaves with 0", async () => {
    const run = await runUnderSignal();

    // Nothing killed it: it decided to leave, and said so.
    expect(run.signal).toBeNull();
    expect(run.code).toBe(0);

    const stages = [...run.stdout.matchAll(/"target":"([a-z]+)"/g)].map(
      (match) => match[1],
    );
    expect(stages).toEqual(["workers", "queues", "redis", "db"]);
    expect(run.stdout).toContain("shutdown started, draining active jobs");
    expect(run.stdout).toContain("shutdown complete");

    // The jobs it had taken are finished, not abandoned half-way: an active
    // job left behind comes back only through the stalled scan, which is what
    // a graceful stop exists to avoid.
    expect(await smoke.getActiveCount()).toBe(0);
    expect(await smoke.getCompletedCount()).toBeGreaterThan(0);
  });

  it("is started by `pnpm dev` exactly the way this test starts it", () => {
    // The DoD names `pnpm --filter @sf/worker dev`, so what that script runs
    // is part of the contract, not a convenience. A watcher (`tsx watch`) or
    // any other parent process would answer the signal itself and kill this
    // one: the drain above would be proven for a command nobody runs.
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(MANIFEST, "utf8")),
    );

    expect(manifest.scripts.dev).toBe(DEV_COMMAND);
  });
});
