import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOT_OPENED,
  type RepeatedSigint,
  SIGINT_REPEAT_WINDOW_MS,
  type ShutdownOptions,
  type ShutdownStage,
  type ShutdownStep,
  createShutdownHandler,
  stageOf,
} from "../src/shutdown.js";
import {
  recordingLogger,
  silentLogger,
} from "../test-support/recording-logger.js";

// Every wait below is the clock's, not the machine's: a loaded CI runner must
// not turn "after the window" into "inside it".
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const FORCED = "forced exit, active jobs return as stalled";
const HINT = "press Ctrl+C again to exit now; unfinished jobs will be retried";
const SAME_KEYPRESS = "repeated SIGINT within the window, same keypress";
const FAILED_START_HINT =
  "shutdown after startup failure is already in progress, press Ctrl+C again to exit now";
const FAILED_START_FORCED =
  "forced exit, shutdown after startup failure did not finish";

/** The worker's choice: a second Ctrl+C leaves at once. */
const FORCE_ON_SIGINT: RepeatedSigint = {
  hint: HINT,
  forcedMessage: FORCED,
  afterFailedStart: {
    hint: FAILED_START_HINT,
    forcedMessage: FAILED_START_FORCED,
  },
};

/** A handler with the parts a case does not care about filled in. */
function handler(
  options: Partial<ShutdownOptions> & Pick<ShutdownOptions, "plan">,
) {
  return createShutdownHandler({
    log: silentLogger(),
    startedMessage: "shutdown started",
    repeatedSigint: "log",
    timeoutMs: 10_000,
    exit: () => {},
    ...options,
  });
}

/** A stage that records its close and, if named, refuses it. */
function stage(
  closed: string[],
  name: string,
  failing?: string,
): ShutdownStage {
  return {
    name,
    close: async (): Promise<void> => {
      closed.push(name);
      if (name === failing) {
        throw new Error(`${name} refused to close`);
      }
    },
  };
}

/** A stage that never finishes: only a forced exit or the deadline ends it. */
const endless: ShutdownStage = {
  name: "workers",
  close: () => new Promise<void>(() => {}),
};

/** The plan of the worker: one line, workers first. */
function workerPlan(closed: string[], failing?: string): ShutdownStep[] {
  return ["workers", "queues", "redis", "db"].map((name) =>
    stage(closed, name, failing),
  );
}

/**
 * The plan of the api: the server first, then the database next to the queue
 * objects and the Redis client they run on.
 */
function apiPlan(
  closed: string[],
  overrides: Partial<
    Record<"app" | "db" | "queues" | "redis", ShutdownStage>
  > = {},
  failing?: string,
): ShutdownStep[] {
  const pick = (name: "app" | "db" | "queues" | "redis") =>
    overrides[name] ?? stage(closed, name, failing);
  return [
    pick("app"),
    { parallel: [[pick("db")], [pick("queues"), pick("redis")]] },
  ];
}

/** The targets whose line has this message, in the order of the lines. */
function targetsOf(
  lines: ReadonlyArray<{ msg: string; target?: unknown }>,
  msg: string,
): unknown[] {
  return lines.filter((line) => line.msg === msg).map((line) => line.target);
}

describe("the order of a stop", () => {
  it("runs a plan of stages in a line", async () => {
    // The worker: a connection closed while a job is running loses that job.
    const closed: string[] = [];
    const codes: number[] = [];

    await handler({
      plan: workerPlan(closed),
      exit: (code) => codes.push(code),
    })("SIGTERM");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
  });

  it("closes the server first, then the branches after it", async () => {
    const closed: string[] = [];
    const codes: number[] = [];

    await handler({
      plan: apiPlan(closed),
      exit: (code) => codes.push(code),
    })("SIGTERM");

    expect(closed[0]).toBe("app");
    expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
    expect(closed.indexOf("queues")).toBeLessThan(closed.indexOf("redis"));
    expect(codes).toEqual([0]);
  });

  it("does not start a branch before the step ahead of it is done", async () => {
    const closed: string[] = [];
    let release: () => void = () => {};
    const app: ShutdownStage = {
      name: "app",
      close: () =>
        new Promise<void>((resolve) => {
          release = () => {
            closed.push("app");
            resolve();
          };
        }),
    };

    const stopping = handler({ plan: apiPlan(closed, { app }) })("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual([]);
    release();
    await stopping;

    expect(closed[0]).toBe("app");
  });

  /**
   * A database whose close never finishes must not hold Redis open: run in a
   * line, the client would stay connected until the deadline killed the
   * process, with no `closed` line for it in the log of the stop.
   */
  it("closes Redis while the database is still closing", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    const { log, lines } = recordingLogger();

    void handler({
      plan: apiPlan(closed, {
        db: { name: "db", close: () => new Promise<void>(() => {}) },
      }),
      log,
      timeoutMs: 50,
      exit: (code) => codes.push(code),
    })("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);

    expect(closed).toEqual(["app", "queues", "redis"]);
    expect(targetsOf(lines, "closed")).toEqual(["app", "queues", "redis"]);
    // The database never closed: the deadline is the verdict.
    expect(codes).toEqual([1]);
  });

  it("keeps Redis after the queues inside its branch", async () => {
    // The queues close through the client they share; a client torn down
    // first leaves them waiting for a reply that cannot come.
    const closed: string[] = [];
    let release: () => void = () => {};
    const queues: ShutdownStage = {
      name: "queues",
      close: () =>
        new Promise<void>((resolve) => {
          release = () => {
            closed.push("queues");
            resolve();
          };
        }),
    };

    const stopping = handler({ plan: apiPlan(closed, { queues }) })("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual(["app", "db"]);
    release();
    await stopping;

    expect(closed).toEqual(["app", "db", "queues", "redis"]);
  });

  /**
   * Whichever target refused - the server, the driver, or either half of the
   * Redis branch - the others are still closed, and the exit code says the
   * stop did not close what it claimed to.
   */
  it.each(["app", "db", "queues", "redis"])(
    "finishes the plan and fails the exit code when %s refuses to close",
    async (failing) => {
      const closed: string[] = [];
      const codes: number[] = [];
      const { log, lines } = recordingLogger();

      await handler({
        plan: apiPlan(closed, {}, failing),
        log,
        exit: (code) => codes.push(code),
      })("SIGTERM");

      expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
      expect(targetsOf(lines, "close failed")).toEqual([failing]);
      expect(codes).toEqual([1]);
    },
  );

  it("finishes a line of stages when one of them throws", async () => {
    const closed: string[] = [];
    const codes: number[] = [];

    await handler({
      plan: workerPlan(closed, "queues"),
      exit: (code) => codes.push(code),
    })("SIGTERM");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([1]);
  });
});

describe("what a close answers", () => {
  /**
   * A target that closed, but not the clean way - the Redis client torn down
   * instead of a QUIT: the stop is clean, but the log must not claim the
   * clean way that never happened.
   */
  it("writes the warning a target closed with and still exits 0", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const refusal = new Error("Connection is closed.");

    await handler({
      plan: apiPlan(closed, {
        redis: {
          name: "redis",
          close: async () => ({
            warning: "closed by disconnect",
            err: refusal,
          }),
        },
      }),
      log,
      exit: (code) => codes.push(code),
    })("SIGTERM");

    expect(lines.filter((line) => line.level === "warn")).toEqual([
      expect.objectContaining({
        signal: "SIGTERM",
        target: "redis",
        msg: "closed by disconnect",
        err: expect.objectContaining({ message: "Connection is closed." }),
      }),
    ]);
    expect(targetsOf(lines, "closed")).not.toContain("redis");
    expect(codes).toEqual([0]);
  });

  it("writes a warning that has no error behind it without one", async () => {
    // A client that was not connected at the stop is torn down without a
    // QUIT, and there is no refusal to show.
    const { log, lines } = recordingLogger();

    await handler({
      plan: [
        {
          name: "redis",
          close: async () => ({ warning: "closed by disconnect" }),
        },
      ],
      log,
    })("SIGTERM");

    const warning = lines.find((line) => line.level === "warn");
    expect(warning).toMatchObject({ msg: "closed by disconnect" });
    expect(warning).not.toHaveProperty("err");
  });

  /**
   * A close may resolve with a value of its own; only an answer shaped as a
   * warning is one. Anything else read as a warning would be a `warn` line
   * with no message in a clean stop.
   */
  it("says a target that was never opened had nothing to close", async () => {
    // A start that failed halfway: `closed` would tell the operator that the
    // server was up and went down.
    const { log, lines } = recordingLogger();
    const codes: number[] = [];

    await handler({
      plan: [
        { name: "app", close: async () => NOT_OPENED },
        { name: "db", close: async () => undefined },
      ],
      log,
      exit: (code) => codes.push(code),
    })("startup failure", { failed: true });

    expect(targetsOf(lines, "not opened, nothing to close")).toEqual(["app"]);
    expect(targetsOf(lines, "closed")).toEqual(["db"]);
    expect(codes).toEqual([1]);
  });

  it("builds a stage that says not opened when its target is missing", async () => {
    // The plan is built before anything is opened; the stage reads its target
    // when the stop runs, and a promise of one is waited for.
    const { log, lines } = recordingLogger();
    const seen: string[] = [];
    // Filled in after the plan is built, the way a start fills in its targets.
    const opened: { db?: { name: string } } = {};

    const stop = handler({
      plan: [
        stageOf(
          "app",
          () => undefined,
          async () => {
            seen.push("app");
          },
        ),
        stageOf(
          "workers",
          async () => undefined,
          async () => {
            seen.push("workers");
          },
        ),
        stageOf(
          "db",
          () => opened.db,
          async (target) => {
            seen.push(target.name);
            return { warning: "closed the hard way" };
          },
        ),
      ],
      log,
    });
    opened.db = { name: "db" };
    await stop("SIGTERM");

    expect(seen).toEqual(["db"]);
    expect(targetsOf(lines, "not opened, nothing to close")).toEqual([
      "app",
      "workers",
    ]);
    expect(targetsOf(lines, "closed the hard way")).toEqual(["db"]);
  });

  it("calls a close that resolved with something other than a warning closed", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    const { log, lines } = recordingLogger();

    await handler({
      plan: apiPlan(closed, {
        app: { name: "app", close: async () => ({ closed: true }) },
        db: { name: "db", close: async () => 3 },
        redis: { name: "redis", close: async () => ({ kind: "quit" }) },
      }),
      log,
      exit: (code) => codes.push(code),
    })("SIGTERM");

    expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    expect(targetsOf(lines, "closed")).toEqual(
      expect.arrayContaining(["app", "db", "queues", "redis"]),
    );
    expect(codes).toEqual([0]);
  });
});

describe("one pass", () => {
  it("only logs a repeated signal instead of closing twice", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = handler({
      plan: workerPlan(closed),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");
    await shutdown("SIGTERM");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
    const repeated = lines.find(
      (line) => line.msg === "shutdown already in progress",
    );
    expect(repeated?.level).toBe("info");
  });

  it("keeps a failure reported while it was already stopping", async () => {
    // Two callers, one stop: a signal starts it, and the start that failed
    // arrives with the reason afterwards. The second call cannot run the plan
    // again, but the exit code is the only thing an orchestrator sees.
    const codes: number[] = [];
    let release: () => void = () => {};
    const shutdown = handler({
      plan: [
        {
          name: "workers",
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("SIGTERM");
    await shutdown("startup failure", { failed: true });
    release();
    await stopping;

    expect(codes).toEqual([1]);
  });

  it("leaves with 1 when the stop is the consequence of a failure", async () => {
    // A port that was taken: every target closes cleanly, the process still
    // did not do what it was started for.
    const closed: string[] = [];
    const codes: number[] = [];

    await handler({
      plan: apiPlan(closed),
      exit: (code) => codes.push(code),
    })("listen failure", { failed: true });

    expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
    expect(codes).toEqual([1]);
  });

  it.each(["SIGINT", "SIGTERM"])(
    "leaves with 1 from a stop %s started when it is asked as a failure",
    async (signal) => {
      // A command whose check a signal cut short: nothing was proven, and the
      // clean stop of a signal must not read as a pass (docs/DECISIONS.md,
      // Р6 E0-12R).
      const closed: string[] = [];
      const codes: number[] = [];

      await handler({
        plan: workerPlan(closed),
        exit: (code) => codes.push(code),
      })(signal, { failed: true });

      expect(closed).toHaveLength(4);
      expect(codes).toEqual([1]);
    },
  );
});

describe("the deadline", () => {
  it("exits on its own when a stage never finishes", async () => {
    // A command to a dead Redis on the queue client waits forever; without
    // the deadline the process would hang here.
    const codes: number[] = [];
    const shutdown = handler({
      plan: [endless],
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(19);
    expect(codes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(codes).toEqual([1]);
  });

  it("keeps the timeout verdict when a slow close finishes afterwards", async () => {
    // The orchestrator reads the exit code of a process, not the last one it
    // meant: a close that finishes late must not overwrite the timeout.
    const codes: number[] = [];
    const shutdown = handler({
      plan: [
        {
          name: "workers",
          close: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
        },
      ],
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(40);
    await stopping;

    expect(codes).toEqual([1]);
  });

  it("holds the process open until it fires", async () => {
    // An unreferenced deadline lets the process leave with 0 the moment
    // nothing else holds the loop - "did not close in time" would read as a
    // clean stop.
    const armed: Array<{ timer: NodeJS.Timeout; delay: unknown }> = [];
    vi.useRealTimers();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = real(...args);
      armed.push({ timer, delay: args[1] });
      return timer;
    }) as typeof setTimeout);
    try {
      void handler({ plan: [endless], timeoutMs: 60_000 })("SIGTERM");
    } finally {
      spy.mockRestore();
    }
    for (const { timer } of armed) {
      clearTimeout(timer);
    }

    // The deadline is the one timer of its length; any other timer of the
    // stop holding the loop would not make this one hold it.
    const deadlines = armed.filter(({ delay }) => delay === 60_000);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]?.timer.hasRef()).toBe(true);
  });
});

describe("the exit", () => {
  it("flushes the log before it exits", async () => {
    // Under pino-pretty the last lines are still in the transport when the
    // stop ends; an exit first cuts off "shutdown complete".
    const calls: string[] = [];
    const log = Object.assign(silentLogger(), {
      flush: (cb?: (err?: Error) => void) => {
        calls.push("flush");
        setTimeout(() => {
          calls.push("flushed");
          cb?.();
        }, 5);
      },
    });
    const exit = vi.fn((code: number) => {
      calls.push(`exit ${code}`);
    });

    const stopping = handler({ plan: [], log, exit })("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await stopping;

    expect(calls).toEqual(["flush", "flushed", "exit 0"]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits anyway when the flush never answers", async () => {
    const log = Object.assign(silentLogger(), { flush: () => {} });
    const exit = vi.fn();

    void handler({ plan: [], log, exit })("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits once when the deadline and the end of the plan meet in the flush", async () => {
    const exit = vi.fn();
    let release: () => void = () => {};
    const log = Object.assign(silentLogger(), {
      flush: (cb?: (err?: Error) => void) => {
        release = () => cb?.();
      },
    });

    const shutdown = handler({
      plan: [endless],
      log,
      timeoutMs: 20,
      exit,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(20);
    await shutdown("startup failure", { failed: true });
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("a second Ctrl+C with the forced exit on", () => {
  /** The worker: a stop that a second Ctrl+C may cut short. */
  function forcing(log = silentLogger(), codes: number[] = []) {
    return handler({
      plan: [endless],
      log,
      startedMessage: "shutdown started, draining active jobs",
      repeatedSigint: FORCE_ON_SIGINT,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });
  }

  it("leaves at once with 130 on a second Ctrl+C", async () => {
    // The operator pressed Ctrl+C again because the drain is taking too long;
    // the jobs in flight come back as stalled, which idempotent jobs survive.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = forcing(log, codes);

    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([130]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced?.msg).toBe(FORCED);
    expect(forced?.failed).toBe(false);
  });

  it("takes copies of one Ctrl+C for a single keypress", async () => {
    // Under `pnpm dev` on Linux and macOS one keypress arrives two or three
    // times within milliseconds; it is still a request for a graceful stop.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = forcing(log, codes);

    void shutdown("SIGINT");
    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS - 1);
    await shutdown("SIGINT");

    expect(codes).toEqual([]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    const copies = lines.filter((line) => line.msg === SAME_KEYPRESS);
    expect(copies.map((line) => line.level)).toEqual(["debug", "debug"]);
  });

  it("does not let the deadline write a second verdict after a forced exit", async () => {
    // Exit is a fake here, so the process stays; in production it would not,
    // but a deadline that still fired would be a second verdict in the log.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = handler({
      plan: [endless],
      log,
      startedMessage: "shutdown started, draining active jobs",
      repeatedSigint: FORCE_ON_SIGINT,
      timeoutMs: 5_000,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(codes).toEqual([130]);
    expect(lines.map((line) => line.msg)).not.toContain(
      "shutdown timed out, exiting",
    );
  });

  it("leaves at once with 130 on Ctrl+C after a SIGTERM", async () => {
    const codes: number[] = [];
    const shutdown = forcing(silentLogger(), codes);

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([130]);
  });

  it("takes a Ctrl+C inside the window after a SIGTERM for a copy, and one after it for a request to leave", async () => {
    // The window is armed by the stop, whichever signal began it: a SIGINT
    // right behind an orchestrator's SIGTERM must not cut the drain short.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = forcing(log, codes);

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS - 1);
    await shutdown("SIGINT");

    expect(codes).toEqual([]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    expect(lines.filter((line) => line.msg === SAME_KEYPRESS)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await shutdown("SIGINT");

    expect(codes).toEqual([130]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced?.msg).toBe(FORCED);
    expect(forced?.failed).toBe(false);
  });

  /**
   * A stop the failed start began: nobody pressed anything to begin it, and
   * the first line of the stop went to nobody at the console. Revised on
   * 22.10.2026 (docs/DECISIONS.md, Р7 E0-12R; before, 17.10.2026, a Ctrl+C
   * there was only "shutdown already in progress" and the operator waited
   * for the deadline).
   */
  function failedStart(log = silentLogger(), codes: number[] = []) {
    let release: () => void = () => {};
    const shutdown = handler({
      plan: [
        {
          name: "redis",
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      log,
      startedMessage: "shutdown started, draining active jobs",
      repeatedSigint: FORCE_ON_SIGINT,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });
    const stopping = shutdown("startup failure", { failed: true });
    return { shutdown, stopping, release: () => release() };
  }

  it("answers the first Ctrl+C of a stop the failed start began with a hint, not an exit", async () => {
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const { shutdown, stopping, release } = failedStart(log, codes);

    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");
    expect(codes).toEqual([]);
    release();
    await stopping;

    expect(codes).toEqual([1]);
    expect(
      lines.filter((line) => line.msg === FAILED_START_HINT),
    ).toMatchObject([{ level: "info", signal: "SIGINT", failed: true }]);
    expect(lines.map((line) => line.msg)).not.toContain(FAILED_START_FORCED);
    expect(lines.map((line) => line.msg)).not.toContain(FORCED);
  });

  it("leaves with the failure's code on the next Ctrl+C after the window", async () => {
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const { shutdown } = failedStart(log, codes);

    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([1]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced).toMatchObject({ msg: FAILED_START_FORCED, failed: true });
    expect(lines.map((line) => line.msg)).not.toContain(FORCED);
  });

  it("takes copies of the first Ctrl+C after a failed start for one keypress, and hints once", async () => {
    // The window is opened by the hint, not by the stop: a keypress that
    // arrives twice right behind the hint must not leave.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const { shutdown } = failedStart(log, codes);

    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS - 1);
    await shutdown("SIGINT");
    // The window of the stop itself would end here; the hint opened its own.
    await vi.advanceTimersByTimeAsync(1);
    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS - 2);
    await shutdown("SIGINT");

    expect(codes).toEqual([]);
    expect(lines.filter((line) => line.msg === FAILED_START_HINT)).toHaveLength(
      1,
    );
    expect(
      lines.filter((line) => line.msg === SAME_KEYPRESS).map((l) => l.level),
    ).toEqual(["debug", "debug"]);

    await vi.advanceTimersByTimeAsync(1);
    await shutdown("SIGINT");
    expect(codes).toEqual([1]);
  });

  it("only logs a SIGTERM during a stop the failed start began", async () => {
    // An orchestrator that repeats its SIGTERM wants the same graceful stop.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const { shutdown, stopping, release } = failedStart(log, codes);

    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGTERM");
    release();
    await stopping;

    expect(codes).toEqual([1]);
    expect(
      lines.find((line) => line.msg === "shutdown already in progress"),
    ).toMatchObject({ level: "info", signal: "SIGTERM" });
    expect(lines.map((line) => line.msg)).not.toContain(FAILED_START_HINT);
  });

  it("forces the exit with the failure's code when the start failed during a signal's stop", async () => {
    // Ctrl+C began the stop, the start failed a moment later, and the operator
    // pressed again: the process still leaves at once, but a supervisor must
    // read "the start broke", not "the operator interrupted".
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    const shutdown = forcing(log, codes);

    void shutdown("SIGINT");
    await shutdown("startup failure", { failed: true });
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([1]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced?.msg).toBe(FORCED);
    expect(forced?.failed).toBe(true);
  });

  it("tells the operator about the second Ctrl+C, and only them", async () => {
    // The hint is for a person at a console; an orchestrator's SIGTERM gets
    // the plain line.
    const fromConsole = recordingLogger();
    await handler({
      plan: [],
      log: fromConsole.log,
      startedMessage: "shutdown started, draining active jobs",
      repeatedSigint: FORCE_ON_SIGINT,
    })("SIGINT");
    const fromOrchestrator = recordingLogger();
    await handler({
      plan: [],
      log: fromOrchestrator.log,
      startedMessage: "shutdown started, draining active jobs",
      repeatedSigint: FORCE_ON_SIGINT,
    })("SIGTERM");

    const firstLine = (lines: ReadonlyArray<{ msg: string; hint?: unknown }>) =>
      lines.find(
        (line) => line.msg === "shutdown started, draining active jobs",
      );
    expect(firstLine(fromConsole.lines)?.hint).toBe(HINT);
    expect(firstLine(fromOrchestrator.lines)).toMatchObject({
      level: "info",
      signal: "SIGTERM",
    });
    expect(firstLine(fromOrchestrator.lines)).not.toHaveProperty("hint");
  });
});

describe("a second Ctrl+C with the forced exit off", () => {
  it("only logs the repeat and lets the stop finish its plan", async () => {
    // The api: nothing in flight loses an attempt, and the stop of a request
    // drain is short - a second Ctrl+C is told about, not obeyed.
    const codes: number[] = [];
    const { log, lines } = recordingLogger();
    let release: () => void = () => {};
    const shutdown = handler({
      plan: [
        {
          name: "app",
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      log,
      repeatedSigint: "log",
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");
    expect(codes).toEqual([]);
    release();
    await stopping;

    expect(codes).toEqual([0]);
    expect(lines.map((line) => line.msg)).not.toContain(FORCED);
    expect(
      lines.find((line) => line.msg === "shutdown already in progress"),
    ).toMatchObject({ level: "info", signal: "SIGINT" });
    expect(
      lines.find((line) => line.msg === "shutdown started"),
    ).not.toHaveProperty("hint");
  });
});
