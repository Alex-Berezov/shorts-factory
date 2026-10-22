import { createDb } from "@sf/db";
import { type ClosableRedis, SIGINT_REPEAT_WINDOW_MS } from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, connectionStages } from "../src/bootstrap.js";
import type { WorkerRuntime } from "../src/runtime.js";

/**
 * The order the process starts and stops in. Ctrl+C cannot be delivered to a
 * child process on Windows (`process.kill` there ends it outright, without
 * running a handler), so the signal path is exercised where it is decided:
 * whoever the subscriber is, it is subscribed before the runtime starts, and
 * the handler closes the stages in the one order that does not lose a job.
 */
const log = pino({ level: "silent" });

/** A runtime that records its stages and can be made slow to start. */
function fakeRuntime(closed: string[]): WorkerRuntime {
  return {
    // The queue factory is never touched by the shutdown path.
    queues: {
      get: () => {
        throw new Error("not used");
      },
      use: () => {
        throw new Error("not used");
      },
      clientErrors: {
        has: () => false,
        writtenByClient: () => false,
        dispose: () => {},
      },
      close: async () => {},
    },
    handled: ["system.smoke"],
    closeWorkers: async () => {
      closed.push("workers");
    },
    closeQueues: async () => {
      closed.push("queues");
    },
    close: async () => {
      closed.push("workers");
      closed.push("queues");
    },
  };
}

/** The connections the entry point owns, recording the order they close in. */
function connections(closed: string[]) {
  return [
    {
      name: "redis",
      close: async () => {
        closed.push("redis");
      },
    },
    {
      name: "db",
      close: async () => {
        closed.push("db");
      },
    },
  ];
}

describe("bootstrap", () => {
  // The clock is the test's: waits below are steps of it, not real sleeps.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens for signals before the runtime takes its first job", async () => {
    // A `Worker` takes jobs from the moment it is constructed, and the start
    // waits on Redis and Postgres. A signal inside that window used to reach
    // Node's default action: the process dies with the jobs it is holding.
    const order: string[] = [];
    const closed: string[] = [];

    await bootstrap({
      log,
      start: async () => {
        order.push("start");
        return fakeRuntime(closed);
      },
      connections: connections(closed),
      subscribe: () => {
        order.push("subscribe");
      },
      exit: () => {},
    });

    expect(order).toEqual(["subscribe", "start"]);
  });

  it("closes the workers first and the connections last", async () => {
    const closed: string[] = [];
    const codes: number[] = [];
    let handler: (signal: string) => void = () => {};

    await bootstrap({
      log,
      start: async () => fakeRuntime(closed),
      connections: connections(closed),
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
    });
    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(10);

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
  });

  it("leaves at once with 130 on a second Ctrl+C", async () => {
    // Through the subscriber, the way production delivers it: the handler
    // passes the signal on, and the second SIGINT is not swallowed on the way.
    const codes: number[] = [];
    let handler: (signal: string) => void = () => {};
    const runtime = fakeRuntime([]);

    await bootstrap({
      log,
      start: async () => ({
        ...runtime,
        // A drain that never ends: only the second Ctrl+C ends the process.
        closeWorkers: () => new Promise<void>(() => {}),
      }),
      connections: connections([]),
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
      timeoutMs: 60_000,
    });
    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(0);

    expect(codes).toEqual([130]);
  });

  it("keeps the failure code when Ctrl+C comes during a stop the start began", async () => {
    // The start failed on its own and the process is closing its connections;
    // an operator who presses Ctrl+C now has no drain to cut short, and 130
    // would hide the failure behind "stopped by hand".
    const codes: number[] = [];
    let handler: (signal: string) => void = () => {};
    let releaseRedis = (): void => {};

    const booting = bootstrap({
      log,
      start: async () => {
        throw new Error("the queue switches are not seeded");
      },
      connections: [
        {
          name: "redis",
          close: () =>
            new Promise<void>((resolve) => {
              releaseRedis = resolve;
            }),
        },
      ],
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(codes).toEqual([]);

    releaseRedis();
    await booting;

    expect(codes).toEqual([1]);
  });

  it("hints on the first Ctrl+C after a failed start and leaves with 1 on the next", async () => {
    // The connections of a start that failed may take until the deadline to
    // close; an operator at the console is told how to leave, and leaving
    // still says the start broke (docs/DECISIONS.md, Р7 E0-12R).
    const codes: number[] = [];
    const { log: recording, lines } = recordingLogger();
    let handler: (signal: string) => void = () => {};

    void bootstrap({
      log: recording,
      start: async () => {
        throw new Error("the queue switches are not seeded");
      },
      connections: [
        { name: "redis", close: () => new Promise<void>(() => {}) },
      ],
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
      timeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(codes).toEqual([]);
    expect(
      lines.find((line) => line.level === "info" && line.signal === "SIGINT"),
    ).toMatchObject({
      msg: "shutdown after startup failure is already in progress, press Ctrl+C again to exit now",
    });

    await vi.advanceTimersByTimeAsync(SIGINT_REPEAT_WINDOW_MS);
    handler("SIGINT");
    await vi.advanceTimersByTimeAsync(0);

    expect(codes).toEqual([1]);
    expect(lines.find((line) => line.level === "error")).toMatchObject({
      msg: "forced exit, shutdown after startup failure did not finish",
      failed: true,
    });
  });

  it("still drains a runtime that was signalled while it was starting", async () => {
    // The stop cannot read a variable the start has not assigned yet: it
    // waits for the start it is interrupting and closes what came out of it.
    const closed: string[] = [];
    const codes: number[] = [];
    let handler: (signal: string) => void = () => {};
    let finishStart = (): void => {};
    const held = new Promise<void>((resolve) => {
      finishStart = resolve;
    });

    const booting = bootstrap({
      log,
      start: async () => {
        await held;
        return fakeRuntime(closed);
      },
      connections: connections(closed),
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
    });

    handler("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);
    expect(closed).toEqual([]);

    finishStart();
    await booting;
    await vi.advanceTimersByTimeAsync(10);

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
  });

  it("fails the exit code when the start throws under a signal", async () => {
    // The redeploy case: SIGTERM arrives while the worker is still coming up
    // (no seed, Redis not there yet) and the start throws a moment later. The
    // stop is already running, so the failure has nowhere to go but the flag
    // it sets on the handler - and without it the process left with 0, which
    // an orchestrator reads as "it meant to stop".
    const closed: string[] = [];
    const codes: number[] = [];
    let handler: (signal: string) => void = () => {};
    let failStart: (err: Error) => void = () => {};
    const held = new Promise<never>((_resolve, reject) => {
      failStart = reject;
    });

    const booting = bootstrap({
      log,
      start: async () => {
        await held;
        return fakeRuntime(closed);
      },
      connections: connections(closed),
      subscribe: (fn) => {
        handler = fn;
      },
      exit: (code) => codes.push(code),
    });

    handler("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);
    expect(codes).toEqual([]);

    failStart(new Error("the queue switches are not seeded"));
    await booting;
    await vi.advanceTimersByTimeAsync(10);

    // Nothing to drain - the runtime never existed - and a code that says so.
    expect(closed).toEqual(["redis", "db"]);
    expect(codes).toEqual([1]);
  });

  it("closes the connections and fails the exit code when the start throws", async () => {
    // The start closes what it opened itself; what is left here is the
    // connections, and a code an orchestrator can act on.
    const closed: string[] = [];
    const codes: number[] = [];

    const runtime = await bootstrap({
      log,
      start: async () => {
        throw new Error("redis is down");
      },
      connections: connections(closed),
      subscribe: () => {},
      exit: (code) => codes.push(code),
    });

    expect(runtime).toBeUndefined();
    expect(closed).toEqual(["redis", "db"]);
    expect(codes).toEqual([1]);
  });

  it("says the workers and the queues were not opened when the start throws", async () => {
    // `closed target=workers` for a runtime that never existed tells the
    // operator the worker was up and drained - the opposite of what happened.
    const { log: recorded, lines } = recordingLogger();
    const codes: number[] = [];

    await bootstrap({
      log: recorded,
      start: async () => {
        throw new Error("redis is down");
      },
      connections: connections([]),
      subscribe: () => {},
      exit: (code) => codes.push(code),
    });

    const targets = (msg: string) =>
      lines.filter((line) => line.msg === msg).map((line) => line.target);
    expect(targets("not opened, nothing to close")).toEqual([
      "workers",
      "queues",
    ]);
    expect(targets("closed")).toEqual(["redis", "db"]);
    expect(codes).toEqual([1]);
  });
});

/**
 * The connections of the entry point as the stop closes them: the Redis
 * client goes through the stage of `@sf/runtime`, the same as the api's.
 */
describe("connectionStages", () => {
  /** Nothing listens on port 1; postgres-js does not connect until asked. */
  const CLOSED_DATABASE_URL =
    "postgres://sf:sf@127.0.0.1:1/shorts_factory_none";

  /** A client that is connected, and whose QUIT is refused. */
  function refusingRedis(refusal: Error): ClosableRedis & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      status: "ready",
      quit: async () => {
        calls.push("quit");
        throw refusal;
      },
      disconnect: () => {
        calls.push("disconnect");
      },
    };
  }

  it("writes a refused QUIT as a disconnect, with the refusal", async () => {
    // Written as `closed` before: the operator could not tell a QUIT from a
    // torn socket, and the reason was gone.
    const refusal = new Error("Connection is closed.");
    const redis = refusingRedis(refusal);
    const { log, lines } = recordingLogger();
    const codes: number[] = [];
    let signal: (name: string) => void = () => {};

    await bootstrap({
      log,
      start: async () => fakeRuntime([]),
      connections: connectionStages(redis, createDb(CLOSED_DATABASE_URL)),
      subscribe: (handler) => {
        signal = handler;
      },
      exit: (code) => codes.push(code),
    });
    signal("SIGTERM");
    await vi.waitFor(() => {
      expect(codes).toEqual([0]);
    });

    expect(redis.calls).toEqual(["quit", "disconnect"]);
    expect(lines.filter((line) => line.target === "redis")).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "closed by disconnect",
        err: expect.objectContaining({ message: "Connection is closed." }),
      }),
    ]);
    expect(
      lines.filter((line) => line.target === "db").map((line) => line.msg),
    ).toEqual(["closed"]);
  });
});
