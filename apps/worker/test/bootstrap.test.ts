import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap.js";
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
      opened: () => [],
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
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toEqual([]);

    finishStart();
    await booting;
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(codes).toEqual([]);

    failStart(new Error("the queue switches are not seeded"));
    await booting;
    await new Promise((resolve) => setTimeout(resolve, 10));

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
});
