import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { env } from "@sf/config";
import { closeRedis } from "@sf/runtime";
import {
  type ChildRun,
  KILL_DEADLINE_MS,
  collectOutput,
  endOf,
  endWithin,
  killed,
  signalled,
  startOf,
} from "@sf/runtime/test-support/child-run";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SMOKE_DEADLINE_MS } from "../src/cli/smoke-run.js";
import { devCommandParts } from "./dev-command.js";
import {
  deleteSmokeUsage,
  keepDatabase,
  obliterateQueues,
  openTestRedis,
  seedQueueSwitches,
  useTestDb,
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
/**
 * How the command, its signal fixture and the worker of the live case are
 * loaded: node with the loader of `pnpm dev` (`DEV_COMMAND`, taken apart by
 * `devCommandParts`), not the `smoke` script of the manifest. That script
 * runs `tsx` as the parent of node; a fork needs node itself as the child,
 * the one the IPC channel and the relayed signal reach - the reason `pnpm dev`
 * starts the worker that way too (docs/DECISIONS.md, 10.09.2026).
 */
const CLI_EXEC_ARGV = devCommandParts().execArgv;
/** The command, as the failures of its waits name it. */
const CLI_NAME = "the smoke command";
/** The worker of the live case, as the failures of its waits name it. */
const WORKER_NAME = "the worker";
/**
 * How long the command may take to come up before its own deadline starts:
 * the start of the process under `tsx`, its connections and the enqueue of
 * its job, on a loaded machine.
 */
const CLI_START_ROOM_MS = 24_000;
/**
 * How long the command may take past its own deadline: the probe of the
 * verdict (`SMOKE_PROBE_MS` of `src/cli/smoke-run.ts`, 1 s) and the close of
 * its connections (`CLOSE_DEADLINE_MS` of `src/cli/smoke.ts`, 5 s). The
 * first is not exported; the second cannot be imported - `smoke.ts` is the
 * entry of the command and runs once imported.
 */
const CLI_FINISH_MS = 6_000;
/**
 * How long the command may take to end on its own: its start, its own
 * deadline (`SMOKE_DEADLINE_MS`) and its finish.
 */
const CLI_END_DEADLINE_MS =
  CLI_START_ROOM_MS + SMOKE_DEADLINE_MS + CLI_FINISH_MS;
/** How long the command may take to enqueue its job and say it waits. */
const WAIT_FOR_WORKER_DEADLINE_MS = 15_000;
/**
 * How long the command may take to end once it is sent the signal: 5 s of
 * `CLOSE_DEADLINE_MS` of `src/cli/smoke.ts` for its connections, and 5 s for
 * the exit. A literal: `smoke.ts` is the entry of the command and runs once
 * imported, so its constant cannot be.
 */
const SIGNALLED_END_DEADLINE_MS = 10_000;
/**
 * How long the worker of the live case may take to close once it is sent the
 * signal: its job is done by then, so its stop only closes what it opened.
 */
const WORKER_STOP_DEADLINE_MS = 10_000;
/** Room for the test itself on top of the deadlines of its waits. */
const CASE_ROOM_MS = 5_000;
/**
 * A run of the command: its end (`endWithin`) lasts `CLI_END_DEADLINE_MS`
 * at most, and a missed one is followed by a single `SIGKILL` that is waited
 * on for `KILL_DEADLINE_MS` at most - so the run is named by its own deadline
 * before the timeout of the case cuts it short.
 */
const RUN_TIMEOUT_MS = CLI_END_DEADLINE_MS + KILL_DEADLINE_MS + CASE_ROOM_MS;

async function runSmokeCli(redisUrl = DEAD_REDIS): Promise<ChildRun> {
  const child = fork(CLI, [], {
    execArgv: CLI_EXEC_ARGV,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, REDIS_URL: redisUrl },
  });
  return await endWithin(
    child,
    endOf(child, collectOutput(child)),
    CLI_END_DEADLINE_MS,
    CLI_NAME,
  );
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
  const db = useTestDb({ beforeAll, afterAll }, { prepare: keepDatabase });
  const redis = openTestRedis();

  beforeAll(async () => {
    await obliterateQueues(redis, ["system.smoke"]);
    await seedQueueSwitches(db());
    await deleteSmokeUsage(db());
  });

  afterEach(async () => {
    await obliterateQueues(redis, ["system.smoke"]);
    await deleteSmokeUsage(db());
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  it(
    "leaves with 1 on a Ctrl+C while it waits, and says it was interrupted, not that the stack failed",
    async () => {
      // No worker runs: the job waits, and so does the command.
      const child = fork(CLI_UNDER_SIGNAL, [], {
        execArgv: CLI_EXEC_ARGV,
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
          {
            what: "the command to wait for a worker",
            intervalMs: 20,
            timeoutMs: WAIT_FOR_WORKER_DEADLINE_MS,
          },
        );
        await signalled(child);
      } catch (err) {
        await killed(child, CLI_NAME);
        throw err;
      }
      const run = await endWithin(
        child,
        ended,
        SIGNALLED_END_DEADLINE_MS,
        CLI_NAME,
      );

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
    },
    WAIT_FOR_WORKER_DEADLINE_MS +
      SIGNALLED_END_DEADLINE_MS +
      KILL_DEADLINE_MS +
      CASE_ROOM_MS,
  );

  it(
    "leaves with 0 once a running worker took the job",
    async () => {
      const worker = fork(WORKER, [], {
        execArgv: CLI_EXEC_ARGV,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const workerOutput = collectOutput(worker);
      const workerEnded = endOf(worker, workerOutput);
      let run: ChildRun;
      try {
        await startOf(worker, workerOutput, {
          deadlineMs: START_DEADLINE_MS,
          tailChars: OUTPUT_TAIL_CHARS,
          name: WORKER_NAME,
        });
        run = await runSmokeCli(env.REDIS_URL);
        // A worker that already left has no channel and is sent nothing; its
        // end below is the verdict either way (`signalled`).
        await signalled(worker);
      } catch (err) {
        await killed(worker, WORKER_NAME);
        throw err;
      }
      await endWithin(
        worker,
        workerEnded,
        WORKER_STOP_DEADLINE_MS,
        WORKER_NAME,
      );

      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(run.output).toContain("smoke job completed");
      expect(run.output).toContain('"msg":"shutdown complete"');
    },
    START_DEADLINE_MS +
      CLI_END_DEADLINE_MS +
      KILL_DEADLINE_MS +
      WORKER_STOP_DEADLINE_MS +
      KILL_DEADLINE_MS +
      CASE_ROOM_MS,
  );
});
