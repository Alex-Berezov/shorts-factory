import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIGINT_REPEAT_WINDOW_MS,
  type ShutdownStage,
  createShutdownHandler,
} from "../src/lib/shutdown.js";
import { recordingLogger, silentLogger } from "./recording-logger.js";

const log = silentLogger();

/** The four stages of the worker stop, recording the order they ran in. */
function stages(closed: string[], failing?: string): ShutdownStage[] {
  return ["workers", "queues", "redis", "db"].map((name) => ({
    name,
    close: async (): Promise<void> => {
      closed.push(name);
      if (name === failing) {
        throw new Error(`${name} refused to close`);
      }
    },
  }));
}

/** A stage that never finishes: only a forced exit or the deadline ends it. */
const endless: ShutdownStage = {
  name: "workers",
  close: () => new Promise<void>(() => {}),
};

const SAME_KEYPRESS = "repeated SIGINT within the window, same keypress";

describe("createShutdownHandler", () => {
  // Every wait below is the clock's, not the machine's: a loaded CI runner
  // must not turn "after the window" into "inside it".
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains the workers before it closes what they run on", async () => {
    // A connection closed while a job is running loses that job - the very
    // thing a graceful stop exists to prevent.
    const closed: string[] = [];
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      stages: stages(closed),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
  });

  it("only logs a repeated SIGTERM instead of closing twice", async () => {
    // An orchestrator that repeats its signal is not asking for anything new:
    // a second pass would close a worker that is already closing.
    const closed: string[] = [];
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: stages(closed),
      log: recorded,
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

  it("leaves at once with 130 on a second Ctrl+C", async () => {
    // The operator pressed Ctrl+C again because the drain is taking too long;
    // the jobs in flight come back as stalled, which idempotent jobs survive.
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: [endless],
      log: recorded,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([130]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced?.msg).toBe("forced exit, active jobs return as stalled");
    expect(forced?.failed).toBe(false);
  });

  it("takes copies of one Ctrl+C for a single keypress", async () => {
    // Under `pnpm dev` on Linux and macOS one keypress arrives two or three
    // times within milliseconds; it is still a request for a graceful stop.
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: [endless],
      log: recorded,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGINT");
    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS - 1);
    await shutdown("SIGINT");

    expect(codes).toEqual([]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    const copies = lines.filter((line) => line.msg === SAME_KEYPRESS);
    expect(copies.map((line) => line.level)).toEqual(["debug", "debug"]);
  });

  it("takes the deadline down with a forced exit", async () => {
    // Exit is a fake here, so the process stays; in production it would not,
    // but a deadline left armed is a second verdict waiting to be written.
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: [endless],
      log: recorded,
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
    const shutdown = createShutdownHandler({
      stages: [endless],
      log,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([130]);
  });

  it("takes a Ctrl+C inside the window after a SIGTERM for a copy, and one after it for a request to leave", async () => {
    // The window is armed by the stop, whichever signal began it: a SIGINT
    // right behind an orchestrator's SIGTERM must not cut the drain short.
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: [endless],
      log: recorded,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

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
    expect(forced?.msg).toBe("forced exit, active jobs return as stalled");
    expect(forced?.failed).toBe(false);
  });

  it("does not force a stop the failed start began", async () => {
    // Nobody pressed anything to begin this stop, so there is no keypress to
    // repeat and no stalled job to warn about; the code stays the failure's.
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    let release: () => void = () => {};
    const shutdown = createShutdownHandler({
      stages: [
        {
          name: "workers",
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      log: recorded,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("startup failure", { failed: true });
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");
    expect(codes).toEqual([]);
    release();
    await stopping;

    expect(codes).toEqual([1]);
    expect(lines.map((line) => line.msg)).not.toContain(
      "forced exit, active jobs return as stalled",
    );
    const repeated = lines.find(
      (line) => line.msg === "shutdown already in progress",
    );
    expect(repeated?.level).toBe("info");
  });

  it("forces the exit with the failure's code when the start failed during a signal's stop", async () => {
    // Ctrl+C began the stop, the start failed a moment later, and the operator
    // pressed again: the process still leaves at once, but a supervisor must
    // read "the start broke", not "the operator interrupted".
    const codes: number[] = [];
    const { log: recorded, lines } = recordingLogger();
    const shutdown = createShutdownHandler({
      stages: [endless],
      log: recorded,
      timeoutMs: 60_000,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGINT");
    await shutdown("startup failure", { failed: true });
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    await shutdown("SIGINT");

    expect(codes).toEqual([1]);
    const forced = lines.find((line) => line.level === "error");
    expect(forced?.msg).toBe("forced exit, active jobs return as stalled");
    expect(forced?.failed).toBe(true);
  });

  it("tells the operator about the second Ctrl+C, and only them", async () => {
    // The hint is for a person at a console; an orchestrator's SIGTERM gets
    // the plain line.
    const fromConsole = recordingLogger();
    await createShutdownHandler({
      stages: stages([]),
      log: fromConsole.log,
      exit: () => {},
    })("SIGINT");
    const fromOrchestrator = recordingLogger();
    await createShutdownHandler({
      stages: stages([]),
      log: fromOrchestrator.log,
      exit: () => {},
    })("SIGTERM");

    const firstLine = (lines: { msg: string; hint?: unknown }[]) =>
      lines.find(
        (line) => line.msg === "shutdown started, draining active jobs",
      );
    expect(firstLine(fromConsole.lines)?.hint).toBe(
      "press Ctrl+C again to exit now; unfinished jobs will be retried",
    );
    expect(firstLine(fromOrchestrator.lines)).toBeDefined();
    expect(firstLine(fromOrchestrator.lines)?.hint).toBeUndefined();
  });

  it("finishes the sequence and fails the exit code when a close throws", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      stages: stages(closed, "queues"),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([1]);
  });

  it("keeps a failure reported while it was already stopping", async () => {
    // Two callers, one stop: a signal starts it, and the start that failed
    // arrives with the reason afterwards. The second call cannot run the
    // stages again, but the exit code is the only thing an orchestrator sees.
    const codes: number[] = [];
    let release: () => void = () => {};
    const shutdown = createShutdownHandler({
      stages: [
        {
          name: "workers",
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      log,
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("SIGTERM");
    await shutdown("startup failure", { failed: true });
    release();
    await stopping;

    expect(codes).toEqual([1]);
  });

  it("exits on its own when a stage never finishes", async () => {
    // With `maxRetriesPerRequest: null` a command to a dead Redis waits
    // forever; without the deadline the process would hang here.
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      stages: [endless],
      log,
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
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      stages: [
        {
          name: "workers",
          close: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
        },
      ],
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    const stopping = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(40);
    await stopping;

    // The orchestrator reads the exit code of a process, not the last one it
    // meant: a close that finishes late must not overwrite the timeout.
    expect(codes).toEqual([1]);
  });
});
