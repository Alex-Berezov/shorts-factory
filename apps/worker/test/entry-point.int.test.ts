import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeDb } from "@sf/db";
import { SIGINT_REPEAT_WINDOW_MS, closeRedis } from "@sf/runtime";
import { Queue } from "bullmq";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { systemSmokeJob } from "../src/jobs/system-smoke.js";
import { type ChildRun, collectOutput, endOf, startOf } from "./child-run.js";
import { DEV_COMMAND, manifestScripts } from "./dev-command.js";
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
/** The bootstrap with a start that fails and a stop that lasts. */
const FAILED_START = fileURLToPath(
  new URL("./fixtures/failed-start-under-signal.ts", import.meta.url),
);
/** Enough jobs that the worker is busy when the signal arrives. */
const JOB_COUNT = 30;
/** How long the worker may take to come up and say so. */
const START_DEADLINE_MS = 20_000;
/** How much of what a child said goes into the failure of its start. */
const OUTPUT_TAIL_CHARS = 2_000;
/**
 * The longest the usage table stays locked once the worker is up, whatever
 * happens to the case. Counted from the start of the worker, not from the
 * lock: a slow start must not use up the hold before the second signal is
 * sent, or the drain finishes and the case is red for a reason that is not the
 * code. Far above what the case needs after the start (the jobs, the first
 * signal, the repeat window, the second signal); with the start deadline it
 * stays under the 30 s test timeout, so a case that fails or hangs never takes
 * the lock into the next case or the next file. Measured from `armBackstop` to
 * the release, ten runs on the development machine held it 1.19-1.33 s: the
 * bound is six times that, and three times the slowest run would still be
 * under it.
 */
const HOLD_MAX_MS = 8_000;

const db = openTestDb();
const redis = openTestRedis();
const smoke = new Queue("system.smoke", { connection: redis });

/**
 * Starts the worker, waits until it is up, signals it and waits for the end.
 * `twice` sends the signal a second time once the first one has started the
 * stop and the repeat window has passed - an operator pressing Ctrl+C again
 * rather than waiting for the drain, not a copy of the first keypress.
 * `onStarted` runs once the worker said it is up.
 *
 * Whatever fails between the start and the signal - the start deadline, a job
 * never picked up - kills the child before the failure is thrown: a worker
 * left running would keep taking the jobs of the next case.
 */
async function runUnderSignal(
  options: {
    twice?: boolean;
    onStarted?: () => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ChildRun> {
  const child = fork(ENTRY, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const output = collectOutput(child);
  const ended = endOf(child, output);

  try {
    await startOf(child, output, {
      deadlineMs: START_DEADLINE_MS,
      tailChars: OUTPUT_TAIL_CHARS,
    });
    options.onStarted?.();

    for (let index = 0; index < JOB_COUNT; index += 1) {
      await systemSmokeJob.enqueue(smoke, {
        requestedAtMs: Date.now() + index,
      });
    }
    await waitFor(
      async () => ((await smoke.getActiveCount()) > 0 ? true : undefined),
      { what: "the worker to pick a job up" },
    );

    child.send("signal");
    if (options.twice === true) {
      await waitFor(
        async () =>
          output().includes("shutdown started, draining active jobs")
            ? true
            : undefined,
        { what: "the first signal to start the stop", intervalMs: 20 },
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SIGINT_REPEAT_WINDOW_MS + 100),
      );
      child.send("signal");
    }
  } catch (err) {
    child.kill("SIGKILL");
    await ended.catch(() => undefined);
    throw err;
  }
  return await ended;
}

/**
 * Keeps every smoke job that reaches its usage row waiting, so that the drain
 * the first signal starts cannot finish before the second signal arrives: the
 * row goes into `api_usage_log`, and an exclusive lock held here blocks writes
 * to it (reads, which the start of the worker may need, still pass). Without
 * it the drain of a job this short races the second message over IPC.
 * `release` lets the writes through and ends the transaction; `armBackstop`,
 * called once the worker is up, lets them through anyway `HOLD_MAX_MS` later,
 * so the lock cannot outlive the case (a worker that never comes up fails the
 * case through the start deadline, and the case releases the lock itself).
 * A transaction that fails before it holds the lock fails the wait for it,
 * rather than leaving the case waiting on nothing.
 */
async function holdUsageWrites(): Promise<{
  armBackstop: () => void;
  release: () => Promise<void>;
}> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let backstop: NodeJS.Timeout | undefined;
  let locked = (): void => undefined;
  let refused = (_err: unknown): void => undefined;
  const isLocked = new Promise<void>((resolve, reject) => {
    locked = resolve;
    refused = reject;
  });
  const transaction = db.$client.begin(async (tx) => {
    await tx`lock table api_usage_log in exclusive mode`;
    locked();
    await released;
  });
  transaction.catch((err: unknown) => {
    clearTimeout(backstop);
    refused(err);
  });
  await isLocked;
  return {
    armBackstop: () => {
      backstop ??= setTimeout(() => release(), HOLD_MAX_MS);
    },
    release: async () => {
      clearTimeout(backstop);
      release();
      await transaction;
    },
  };
}

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  await seedQueueSwitches(db);
  await deleteSmokeUsage(db);
});

/** How many usage rows smoke runs have left in the table. */
async function countSmokeUsage(): Promise<number> {
  const rows = await db.$client<{ count: number }[]>`
    select count(*)::int as count from api_usage_log
    where provider = 'system' and operation = 'smoke'
  `;
  return rows[0]?.count ?? 0;
}

// Every case starts from a table with no smoke rows: a row the previous case
// left behind - a write of its child that landed after that case's delete -
// fails here by name instead of passing for the wrong reason further on.
beforeEach(async () => {
  expect(
    await countSmokeUsage(),
    "smoke usage rows left by the previous case",
  ).toBe(0);
});

// Each case leaves what its child process could not finish: jobs it was
// holding come back as stalled, and its usage rows stay in the table.
afterEach(async () => {
  await obliterateQueues(redis, QUEUES);
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

    const stages = [...run.output.matchAll(/"target":"([a-z]+)"/g)].map(
      (match) => match[1],
    );
    expect(stages).toEqual(["workers", "queues", "redis", "db"]);
    expect(run.output).toContain("shutdown started, draining active jobs");
    expect(run.output).toContain("shutdown complete");

    // The jobs it had taken are finished, not abandoned half-way: an active
    // job left behind comes back only through the stalled scan, which is what
    // a graceful stop exists to avoid.
    expect(await smoke.getActiveCount()).toBe(0);
    expect(await smoke.getCompletedCount()).toBeGreaterThan(0);
  });

  it("leaves at once with 130 when the signal comes a second time", async () => {
    let hold: Awaited<ReturnType<typeof holdUsageWrites>> | undefined;
    let run: ChildRun;
    try {
      hold = await holdUsageWrites();
      run = await runUnderSignal({ twice: true, onStarted: hold.armBackstop });
    } catch (err) {
      // This failure is the one that explains the red case; a release that
      // fails on top of it must not replace it.
      await hold?.release().catch(() => undefined);
      throw err;
    }
    await hold.release();

    // The process chose the code itself; nothing outside killed it.
    expect(run.signal).toBeNull();
    expect(run.code).toBe(130);
    expect(run.output).toContain("shutdown started, draining active jobs");
    expect(run.output).toContain("forced exit, active jobs return as stalled");
  });

  it("fails at once, with the reason, when the worker dies on its way up", async () => {
    // A config the worker refuses at import: the child exits with 1 before
    // it can say it started. Monotonic: a step of the wall clock is no time
    // the start took.
    const startedAt = performance.now();

    await expect(
      runUnderSignal({ env: { ...process.env, LOG_LEVEL: "loud" } }),
    ).rejects.toThrow(/exited before it started \(code 1, .*LOG_LEVEL/s);
    expect(performance.now() - startedAt).toBeLessThan(START_DEADLINE_MS / 2);
  });

  it("hints on Ctrl+C after a failed start and leaves with 1 on the next", async () => {
    // The stop a failed start began has no jobs to drain and may last until
    // its deadline; the operator is told how to leave, and leaving still says
    // the start broke (docs/DECISIONS.md, Р7 E0-12R).
    const child = fork(FAILED_START, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const output = collectOutput(child);
    const ended = endOf(child, output);
    const said = (text: string) => async () =>
      output().includes(text) ? true : undefined;

    try {
      await waitFor(said("worker failed to start"), {
        what: "the start to fail",
        intervalMs: 20,
      });
      child.send("signal");
      await waitFor(
        said(
          "shutdown after startup failure is already in progress, press Ctrl+C again to exit now",
        ),
        { what: "the hint of the first Ctrl+C", intervalMs: 20 },
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SIGINT_REPEAT_WINDOW_MS + 100),
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
    expect(run.output).toContain(
      "forced exit, shutdown after startup failure did not finish",
    );
    expect(run.output).not.toContain("shutdown timed out");
  });

  it("is started by `pnpm dev` exactly the way this test starts it", () => {
    // The DoD names `pnpm --filter @sf/worker dev`, so what that script runs
    // is part of the contract, not a convenience. A watcher (`tsx watch`) or
    // any other parent process would answer the signal itself and kill this
    // one: the drain above would be proven for a command nobody runs.
    expect(manifestScripts().dev).toBe(DEV_COMMAND);
  });
});
