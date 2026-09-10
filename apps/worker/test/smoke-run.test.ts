import { describe, expect, it } from "vitest";
import {
  type SmokeEvents,
  type SmokeQueue,
  runSmoke,
} from "../src/cli/smoke-run.js";
import { recordingLogger, silentLogger } from "./recording-logger.js";

/**
 * The command an operator runs when they want to know whether the pipeline is
 * alive. Its two failure modes are the interesting part: it has to answer at
 * all when the stack is down (the connection underneath waits forever by
 * design), and it has to name the right thing when the queue is switched off.
 */
const silent = silentLogger();

/** Events nobody ever emits, ready whenever the run asks. */
function idleEvents(): SmokeEvents & {
  emit(event: "completed" | "failed", args: unknown): void;
} {
  const listeners = new Map<
    string,
    ((args: { jobId: string; failedReason?: string }) => void)[]
  >();
  return {
    waitUntilReady: async () => {},
    on: (event, listener) => {
      const kept = listeners.get(event) ?? [];
      kept.push(listener);
      listeners.set(event, kept);
      return undefined;
    },
    emit: (event, args) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(args as { jobId: string; failedReason?: string });
      }
    },
  };
}

/** A queue with nothing in it; `paused` is what the test varies. */
function idleQueue(paused: boolean): SmokeQueue {
  return {
    isPaused: async () => paused,
    getJob: async () => undefined,
  };
}

describe("runSmoke", () => {
  it("answers as soon as the worker reports the job done", async () => {
    const events = idleEvents();
    const outcome = runSmoke({
      events,
      queue: idleQueue(false),
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 5_000,
      pollIntervalMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    events.emit("completed", { jobId: "system.smoke/1" });

    expect(await outcome).toEqual({ ok: true });
  });

  it("passes on the reason a job failed", async () => {
    const events = idleEvents();
    const outcome = runSmoke({
      events,
      queue: idleQueue(false),
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 5_000,
      pollIntervalMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    events.emit("failed", {
      jobId: "system.smoke/1",
      failedReason: "the database is not there",
    });

    expect(await outcome).toEqual({
      ok: false,
      reason: "the database is not there",
    });
  });

  it("gives up on its own when the connection never comes up", async () => {
    // The deadline has to cover `waitUntilReady` and the `add`, not only the
    // wait for a result: with the stack down both of them queue up offline and
    // wait for a socket that never arrives, and the command would print
    // nothing at all - no deadline, no reason.
    const never = new Promise<unknown>(() => {});
    const events: SmokeEvents = {
      waitUntilReady: () => never,
      on: () => undefined,
    };

    const outcome = await runSmoke({
      events,
      queue: idleQueue(false),
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 40,
      pollIntervalMs: 10,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("is the worker running");
  });

  it("answers even when the queue cannot be asked whether it is off", async () => {
    // The deadline handler used to ask `isPaused()` and wait for it. With the
    // stack down that call goes through BullMQ's `waitUntilReady`, which
    // resolves on `ready` or on `end`, and a client that reconnects forever
    // reaches neither: the timer fired and the command still printed nothing.
    const never = new Promise<boolean>(() => {});
    const queue: SmokeQueue = {
      isPaused: () => never,
      getJob: () => new Promise(() => {}),
    };

    const outcome = await runSmoke({
      events: idleEvents(),
      queue,
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 40,
      pollIntervalMs: 10,
      probeMs: 20,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("could not even be asked");
    expect(outcome.reason).toContain("Redis");
  });

  it("names the switch when the queue is the thing that is off", async () => {
    // A paused queue keeps the job in `waiting`, so this is not "the job is
    // lost" - it is "nobody will take it until the switch goes back".
    const outcome = await runSmoke({
      events: idleEvents(),
      queue: idleQueue(true),
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 40,
      pollIntervalMs: 10,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("paused");
    expect(outcome.reason).toContain("queues.enabled");
  });

  it("sees a job that finished before anyone was listening", async () => {
    // The event stream is the fast path; the state in Redis is the truth.
    const queue: SmokeQueue = {
      isPaused: async () => false,
      getJob: async () => ({ getState: async () => "completed" }),
    };

    const outcome = await runSmoke({
      events: idleEvents(),
      queue,
      enqueue: async () => "system.smoke/1",
      log: silent,
      deadlineMs: 2_000,
      pollIntervalMs: 10,
    });

    expect(outcome).toEqual({ ok: true });
  });

  it("reports an enqueue that was refused instead of waiting it out", async () => {
    const { log, lines } = recordingLogger();

    const outcome = await runSmoke({
      events: idleEvents(),
      queue: idleQueue(false),
      enqueue: async () => {
        throw new Error("connection is closed");
      },
      log,
      deadlineMs: 5_000,
      pollIntervalMs: 10,
    });

    expect(outcome.ok).toBe(false);
    expect(lines.filter((line) => line.level === "error")).toHaveLength(1);
  });
});
