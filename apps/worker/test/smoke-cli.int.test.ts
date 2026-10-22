import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { env } from "@sf/config";
import { closeDb } from "@sf/db";
import { closeRedis } from "@sf/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ChildRun, collectOutput, endOf, startOf } from "./child-run.js";
import {
  deleteSmokeUsage,
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
  waitFor,
} from "./helpers.int.js";

/**
 * `pnpm --filter @sf/worker smoke` against a Redis that is not there.
 *
 * The one thing a fake queue cannot reproduce: the client the command really
 * uses keeps retrying forever and queues commands offline (BullMQ's
 * requirement, `createQueueRedis` of `@sf/runtime`), so every promise in this path - the
 * `waitUntilReady`, the `add`, the `isPaused` behind the verdict, the `quit`
 * behind the exit - can be one that never settles. This run proves the command
 * still ends by itself, says which of the two things is wrong and leaves with
 * a code a script can read.
 *
 * No Compose needed for that one, and it is in the integration suite anyway:
 * it costs the full deadline of the command, which `pnpm test` should not.
 * The cases against the Redis of the suite, below, do need the stack.
 */
const CLI = fileURLToPath(new URL("../src/cli/smoke.ts", import.meta.url));
/** The command with the signal a parent cannot deliver on Windows relayed. */
const CLI_UNDER_SIGNAL = fileURLToPath(
  new URL("./fixtures/smoke-under-signal.ts", import.meta.url),
);
/** The real worker entry point, which takes the smoke job in the live case. */
const WORKER = fileURLToPath(
  new URL("./fixtures/entry-under-signal.ts", import.meta.url),
);
/** How long the worker may take to come up and say so. */
const START_DEADLINE_MS = 20_000;
/** How much of what a child said goes into the failure of its start. */
const OUTPUT_TAIL_CHARS = 2_000;
/** A port nothing listens on; connecting is refused rather than hanging. */
const DEAD_REDIS = "redis://127.0.0.1:1";
/** The command's own deadline is 30 s, plus the probe and the closing. */
const RUN_TIMEOUT_MS = 90_000;

async function runSmokeCli(redisUrl = DEAD_REDIS): Promise<ChildRun> {
  const child = fork(CLI, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, REDIS_URL: redisUrl },
  });
  return await endOf(child, collectOutput(child));
}

describe("smoke cli against a dead redis", () => {
  it(
    "ends on its own, names the reason and exits non-zero",
    async () => {
      const run = await runSmokeCli();

      // Nothing outside killed it: it decided to stop.
      expect(run.signal).toBeNull();
      expect(run.code).toBe(1);
      expect(run.output).toContain("smoke job did not complete");
      expect(run.output).toContain("could not even be asked");
      // The stop of the package, after the verdict (docs/DECISIONS.md, Р6
      // E0-12R): its first line, and - the event stream waits for a Redis
      // that never comes - the line of its deadline, which is the exit code.
      const verdictAt = run.output.indexOf("smoke job did not complete");
      const startedAt = run.output.indexOf('"msg":"shutdown started"');
      expect(startedAt).toBeGreaterThan(verdictAt);
      expect(
        run.output.indexOf('"msg":"shutdown timed out, exiting"'),
      ).toBeGreaterThan(startedAt);
    },
    RUN_TIMEOUT_MS,
  );
});

/**
 * The command against the Redis of the suite: the two codes a dead Redis
 * cannot show - 0 for a job a worker really took, and 1 for a check a
 * Ctrl+C cut short while it waited (docs/DECISIONS.md, Р6 E0-12R).
 */
describe("smoke cli against the redis of the suite", () => {
  const db = openTestDb();
  const redis = openTestRedis();

  beforeAll(async () => {
    await obliterateQueues(redis, ["system.smoke"]);
    await seedQueueSwitches(db);
    await deleteSmokeUsage(db);
  });

  afterEach(async () => {
    await obliterateQueues(redis, ["system.smoke"]);
    await deleteSmokeUsage(db);
  });

  afterAll(async () => {
    await closeDb(db);
    await closeRedis(redis);
  });

  it("leaves with 1 on a Ctrl+C while it waits, and says it was interrupted, not that the stack failed", async () => {
    // No worker runs: the job waits, and so does the command.
    const child = fork(CLI_UNDER_SIGNAL, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const output = collectOutput(child);
    const ended = endOf(child, output);
    try {
      await waitFor(
        async () =>
          output().includes("smoke job enqueued, waiting for a worker")
            ? true
            : undefined,
        { what: "the command to wait for a worker", intervalMs: 20 },
      );
      child.send("signal");
    } catch (err) {
      child.kill("SIGKILL");
      await ended.catch(() => undefined);
      throw err;
    }
    const run = await ended;

    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.output).toContain("smoke check interrupted, nothing proven");
    expect(run.output).toContain('"msg":"shutdown complete"');
    expect(run.output).not.toContain("smoke job did not complete");
    expect(run.output).not.toContain("could not be enqueued");
    expect(run.output).not.toContain("could not read the job state");
    // pino writes the levels as numbers: nothing at warn but the one line,
    // nothing at error at all.
    expect(run.output.match(/"level":40/g)).toHaveLength(1);
    expect(run.output).not.toContain('"level":50');
  });

  it("leaves with 0 once a running worker took the job", async () => {
    const worker = fork(WORKER, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const workerOutput = collectOutput(worker);
    const workerEnded = endOf(worker, workerOutput);
    let run: ChildRun;
    try {
      await startOf(worker, workerOutput, {
        deadlineMs: START_DEADLINE_MS,
        tailChars: OUTPUT_TAIL_CHARS,
      });
      run = await runSmokeCli(env.REDIS_URL);
    } finally {
      if (worker.connected) {
        worker.send("signal");
      }
      await workerEnded.catch(() => undefined);
    }

    expect(run.signal).toBeNull();
    expect(run.code).toBe(0);
    expect(run.output).toContain("smoke job completed");
    expect(run.output).toContain('"msg":"shutdown complete"');
  }, 60_000);
});
