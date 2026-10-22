import {
  recordingLogger,
  silentLogger,
} from "@sf/runtime/test-support/recording-logger";
import { describe, expect, it, vi } from "vitest";
import {
  type SmokeEvents,
  type SmokeOutcome,
  type SmokeQueue,
  runSmoke,
  runSmokeCommand,
} from "../src/cli/smoke-run.js";

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

  it("answers at once when it is interrupted, and calls nothing that fails after that a fault", async () => {
    // The stop closes the connections under the run: the enqueue and the
    // poll fail because of it, not because Redis is down.
    const { log, lines } = recordingLogger();
    const interruption = new AbortController();
    let refuse: (err: Error) => void = () => {};
    const outcome = runSmoke({
      events: idleEvents(),
      queue: idleQueue(false),
      enqueue: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject;
        }),
      log,
      deadlineMs: 5_000,
      pollIntervalMs: 10,
      interrupted: interruption.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    interruption.abort();
    expect(await outcome).toEqual({
      ok: false,
      reason: "interrupted by a signal",
    });
    refuse(new Error("Connection is closed."));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      lines.filter((line) => line.level === "error" || line.level === "warn"),
    ).toEqual([]);
  });

  it("says nothing of a job state it could not read while it is being stopped", async () => {
    const { log, lines } = recordingLogger();
    const interruption = new AbortController();
    let asked = 0;
    const outcome = runSmoke({
      events: idleEvents(),
      queue: {
        isPaused: async () => false,
        getJob: async () => {
          asked += 1;
          if (asked === 1) {
            interruption.abort();
          }
          throw new Error("Connection is closed.");
        },
      },
      enqueue: async () => "system.smoke/1",
      log,
      deadlineMs: 5_000,
      pollIntervalMs: 10,
      interrupted: interruption.signal,
    });

    expect((await outcome).ok).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      lines.filter((line) => line.level === "error" || line.level === "warn"),
    ).toEqual([]);
  });

  it("puts nothing on the queue when it is interrupted before it starts", async () => {
    // A Ctrl+C in the first milliseconds of the command: the run is told on
    // its way in, and a job enqueued now would still be done by the worker.
    const interruption = new AbortController();
    interruption.abort();
    let enqueued = 0;

    const outcome = await runSmoke({
      events: idleEvents(),
      queue: idleQueue(false),
      enqueue: async () => {
        enqueued += 1;
        return "system.smoke/1";
      },
      log: silent,
      deadlineMs: 5_000,
      pollIntervalMs: 10,
      interrupted: interruption.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome).toEqual({ ok: false, reason: "interrupted by a signal" });
    expect(enqueued).toBe(0);
  });

  it.each([
    ["a signal", { deadlineMs: 5_000, interrupt: true }],
    ["the deadline", { deadlineMs: 20, interrupt: false }],
  ])(
    "puts nothing on the queue once %s has given the verdict while the stream was coming up",
    async (_what, { deadlineMs, interrupt }) => {
      const interruption = new AbortController();
      let ready: () => void = () => {};
      let enqueued = 0;
      const { log, lines } = recordingLogger();

      const outcome = runSmoke({
        events: {
          waitUntilReady: () =>
            new Promise<unknown>((resolve) => {
              ready = () => resolve(undefined);
            }),
          on: () => undefined,
        },
        queue: idleQueue(false),
        enqueue: async () => {
          enqueued += 1;
          return "system.smoke/1";
        },
        log,
        deadlineMs,
        pollIntervalMs: 10,
        probeMs: 10,
        interrupted: interruption.signal,
      });
      if (interrupt) {
        interruption.abort();
      }
      expect((await outcome).ok).toBe(false);

      ready();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(enqueued).toBe(0);
      expect(lines.filter((line) => line.level === "info")).toEqual([]);
    },
  );

  it("arms no poll once the verdict came while the job was being added", async () => {
    // The interval is cleared when the verdict is in; armed after that, it
    // would keep asking Redis until the process exits.
    const interruption = new AbortController();
    let added: (id: string) => void = () => {};
    let asked = 0;

    const outcome = runSmoke({
      events: idleEvents(),
      queue: {
        isPaused: async () => false,
        getJob: async () => {
          asked += 1;
          return undefined;
        },
      },
      enqueue: () =>
        new Promise<string>((resolve) => {
          added = resolve;
        }),
      log: silent,
      deadlineMs: 5_000,
      pollIntervalMs: 5,
      interrupted: interruption.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    interruption.abort();
    expect((await outcome).ok).toBe(false);

    added("system.smoke/1");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked).toBe(0);
  });

  it("says nothing of waiting for a worker once a signal came while the job was being added", async () => {
    // The line after the add used to come out under "interrupted": the run
    // was over, and the log said it was waiting.
    const { log, lines } = recordingLogger();
    const interruption = new AbortController();
    let added: (id: string) => void = () => {};

    const outcome = runSmoke({
      events: idleEvents(),
      queue: idleQueue(false),
      enqueue: () =>
        new Promise<string>((resolve) => {
          added = resolve;
        }),
      log,
      deadlineMs: 5_000,
      pollIntervalMs: 10_000,
      interrupted: interruption.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    interruption.abort();
    expect(await outcome).toEqual({
      ok: false,
      reason: "interrupted by a signal",
    });

    added("system.smoke/1");
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.filter((line) => line.level === "info")).toEqual([]);
  });

  it("calls a refused enqueue no reason once the deadline has given the verdict", async () => {
    // The verdict of the deadline is the reason; an error after it would name
    // another one for a run that is already decided.
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let refuse: (err: Error) => void = () => {};

      const outcome = runSmoke({
        events: idleEvents(),
        queue: idleQueue(false),
        enqueue: () =>
          new Promise<string>((_resolve, reject) => {
            refuse = reject;
          }),
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 10_000,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const verdict = await outcome;
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("is the worker running");

      refuse(new Error("Connection is closed."));
      await vi.advanceTimersByTimeAsync(0);

      expect(lines.filter((line) => line.level === "error")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts nothing on the queue once the deadline fired, while the verdict still waits for its reason", async () => {
    // The deadline decides the run when it fires; the second it then spends
    // asking whether the queue is paused is not a second more to start the
    // job in.
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let ready: () => void = () => {};
      let enqueued = 0;

      const outcome = runSmoke({
        events: {
          waitUntilReady: () =>
            new Promise<unknown>((resolve) => {
              ready = () => resolve(undefined);
            }),
          on: () => undefined,
        },
        queue: {
          isPaused: () => new Promise<boolean>(() => {}),
          getJob: async () => undefined,
        },
        enqueue: async () => {
          enqueued += 1;
          return "system.smoke/1";
        },
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 10_000,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      ready();
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueued).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect((await outcome).reason).toContain("could not even be asked");
      expect(enqueued).toBe(0);
      expect(lines.filter((line) => line.level === "info")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing of waiting and arms no poll once the deadline fired while the job was being added", async () => {
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let added: (id: string) => void = () => {};
      let asked = 0;

      const outcome = runSmoke({
        events: idleEvents(),
        queue: {
          isPaused: () => new Promise<boolean>(() => {}),
          getJob: async () => {
            asked += 1;
            return undefined;
          },
        },
        enqueue: () =>
          new Promise<string>((resolve) => {
            added = resolve;
          }),
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 10,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      added("system.smoke/1");
      await vi.advanceTimersByTimeAsync(50);

      expect(lines.filter((line) => line.level === "info")).toEqual([]);
      expect(asked).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect((await outcome).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing of a job state it could not read once the deadline has given the verdict", async () => {
    // A read in flight when the deadline fires fails after the verdict: it is
    // no news about the stack, and a warning would follow the reason.
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let refuse: (err: Error) => void = () => {};

      const outcome = runSmoke({
        events: idleEvents(),
        queue: {
          isPaused: async () => false,
          getJob: () =>
            new Promise((_resolve, reject) => {
              refuse = reject;
            }),
        },
        enqueue: async () => "system.smoke/1",
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 900,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await outcome).reason).toContain("is the worker running");

      refuse(new Error("Connection is closed."));
      await vi.advanceTimersByTimeAsync(0);

      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["an event of the job", { pollIntervalMs: 10_000, viaEvent: true }],
    ["a read of its state", { pollIntervalMs: 900, viaEvent: false }],
  ])(
    "keeps the verdict of the deadline when %s says it completed while the reason is being asked for",
    async (_what, { pollIntervalMs, viaEvent }) => {
      // The deadline fired: the second spent asking whether the queue is
      // paused is not a second more for the job to pass in.
      vi.useFakeTimers();
      try {
        const events = idleEvents();
        let read: (state: string) => void = () => {};
        const outcome = runSmoke({
          events,
          queue: {
            isPaused: () => new Promise<boolean>(() => {}),
            getJob: async () => ({
              getState: () =>
                new Promise<string>((resolve) => {
                  read = resolve;
                }),
            }),
          },
          enqueue: async () => "system.smoke/1",
          log: silent,
          deadlineMs: 1_000,
          pollIntervalMs,
          probeMs: 100,
        });
        await vi.advanceTimersByTimeAsync(1_000);

        if (viaEvent) {
          events.emit("completed", { jobId: "system.smoke/1" });
        } else {
          read("completed");
        }
        await vi.advanceTimersByTimeAsync(100);

        const verdict = await outcome;
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toContain("could not even be asked");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("calls a refused enqueue no reason while the deadline waits for its own", async () => {
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let refuse: (err: Error) => void = () => {};

      const outcome = runSmoke({
        events: idleEvents(),
        queue: {
          isPaused: () => new Promise<boolean>(() => {}),
          getJob: async () => undefined,
        },
        enqueue: () =>
          new Promise<string>((_resolve, reject) => {
            refuse = reject;
          }),
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 10_000,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      refuse(new Error("Connection is closed."));
      await vi.advanceTimersByTimeAsync(0);

      expect(lines.filter((line) => line.level === "error")).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect((await outcome).reason).toContain("could not even be asked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing of a job state it could not read while the deadline waits for its reason", async () => {
    vi.useFakeTimers();
    try {
      const { log, lines } = recordingLogger();
      let refuse: (err: Error) => void = () => {};

      const outcome = runSmoke({
        events: idleEvents(),
        queue: {
          isPaused: () => new Promise<boolean>(() => {}),
          getJob: () =>
            new Promise((_resolve, reject) => {
              refuse = reject;
            }),
        },
        enqueue: async () => "system.smoke/1",
        log,
        deadlineMs: 1_000,
        pollIntervalMs: 900,
        probeMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      refuse(new Error("Connection is closed."));
      await vi.advanceTimersByTimeAsync(0);

      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect((await outcome).reason).toContain("could not even be asked");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The command around the run: what it asks the stop for decides the exit
 * code, and a script reads nothing else (docs/DECISIONS.md, Р6 E0-12R).
 */
describe("runSmokeCommand", () => {
  /** The command over a run the case decides, and what it did. */
  function command(
    run: (
      interrupted: AbortSignal,
      onVerdict: (outcome: SmokeOutcome) => void,
    ) => Promise<SmokeOutcome>,
  ) {
    const { log, lines } = recordingLogger();
    const steps: string[] = [];
    const stops: Array<[string, boolean | undefined]> = [];
    let signal: (name: string) => void = () => {
      throw new Error("no subscription was made");
    };
    const done = runSmokeCommand({
      subscribe: (handler) => {
        steps.push("subscribe");
        signal = handler;
      },
      shutdown: async (name, request) => {
        steps.push(`shutdown ${name}`);
        stops.push([name, request?.failed]);
      },
      run: (interrupted, onVerdict) => {
        steps.push("run");
        return run(interrupted, onVerdict);
      },
      log,
    });
    return {
      done,
      steps,
      stops,
      lines,
      signal: (name: string) => signal(name),
    };
  }

  it("subscribes to the signals before it opens anything", async () => {
    const { done, steps } = command(async () => ({ ok: true }));
    await done;

    expect(steps).toEqual(["subscribe", "run", "shutdown smoke done"]);
  });

  it("asks for a clean stop after a job that went through", async () => {
    const { done, stops, lines } = command(async () => ({ ok: true }));
    await done;

    expect(lines.map((line) => line.msg)).toEqual(["smoke job completed"]);
    expect(stops).toEqual([["smoke done", false]]);
  });

  it("asks for a failed stop after a job that did not complete, with the reason above it", async () => {
    const { done, stops, lines } = command(async () => ({
      ok: false,
      reason: "no result in 30s",
    }));
    await done;

    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "smoke job did not complete",
        reason: "no result in 30s",
      }),
    ]);
    expect(stops).toEqual([["smoke done", true]]);
  });

  it("asks for a failed stop after a run that threw, and says why", async () => {
    const { done, stops, lines } = command(async () => {
      throw new Error("the queue could not be built");
    });
    await done;

    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "smoke run failed",
        err: expect.objectContaining({
          message: "the queue could not be built",
        }),
      }),
    ]);
    expect(stops).toEqual([["smoke done", true]]);
  });

  it.each(["SIGINT", "SIGTERM"])(
    "asks for a failed stop on %s before the verdict: nothing was proven",
    async (name) => {
      let finish: (outcome: SmokeOutcome) => void = () => {};
      const { done, stops, signal } = command(
        () =>
          new Promise<SmokeOutcome>((resolve) => {
            finish = resolve;
          }),
      );

      signal(name);
      expect(stops).toEqual([[name, true]]);

      // The run still ends; what it says later changes nothing of the stop.
      finish({ ok: true });
      await done;
      expect(stops).toEqual([[name, true]]);
    },
  );

  it.each([
    ["a verdict", async () => ({ ok: false, reason: "the job failed" })],
    [
      "a failure",
      async () => {
        throw new Error("Connection is closed.");
      },
    ],
  ])(
    "says once that a signal before the verdict interrupted the check, and nothing of %s after it",
    async (_what, after: () => Promise<SmokeOutcome>) => {
      // What fails once the stop closes the connections under the run is the
      // stop, not a stack that is down.
      let seen: AbortSignal | undefined;
      let release: () => void = () => {};
      const { done, lines, signal } = command(async (interrupted) => {
        seen = interrupted;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return await after();
      });

      signal("SIGINT");
      signal("SIGINT");
      expect(seen?.aborted).toBe(true);
      release();
      await done;

      expect(
        lines.filter(
          (line) => line.level !== "debug" && line.level !== "trace",
        ),
      ).toEqual([
        expect.objectContaining({
          level: "warn",
          msg: "smoke check interrupted, nothing proven",
          signal: "SIGINT",
        }),
      ]);
    },
  );

  it.each([
    [
      "a run that threw",
      async (): Promise<SmokeOutcome> => {
        throw new Error("the queue could not be built");
      },
      "smoke run failed",
    ],
    [
      "a verdict that failed",
      async (): Promise<SmokeOutcome> => ({
        ok: false,
        reason: "no result in 30s",
      }),
      "smoke job did not complete",
    ],
  ])(
    "does not call a signal after %s an interruption: the reason stays the last word",
    async (_what, run, reason) => {
      // Ctrl+C while "smoke done" is closing: the run is over, nothing was
      // interrupted, and a warn under the error would send the operator after
      // the wrong cause.
      const { done, stops, lines, signal } = command(run);
      await done;

      signal("SIGINT");

      expect(
        lines.filter(
          (line) => line.level !== "debug" && line.level !== "trace",
        ),
      ).toEqual([expect.objectContaining({ level: "error", msg: reason })]);
      expect(stops).toEqual([
        ["smoke done", true],
        ["SIGINT", true],
      ]);
    },
  );

  it("keeps a passed verdict through a signal that comes after it", async () => {
    let finish: (outcome: SmokeOutcome) => void = () => {};
    const { done, stops, signal } = command(
      () =>
        new Promise<SmokeOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    finish({ ok: true });
    await done;

    signal("SIGINT");

    expect(stops).toEqual([
      ["smoke done", false],
      ["SIGINT", false],
    ]);
  });

  it("keeps a passed verdict through a signal that comes before the run has handed it back", async () => {
    // The job completed and the run decided; the signal came in the turns it
    // takes the verdict to travel back to the command. Nothing was cut short.
    const events = idleEvents();
    const { done, stops, lines, signal } = command((interrupted, onVerdict) =>
      runSmoke({
        events,
        queue: idleQueue(false),
        enqueue: async () => "system.smoke/1",
        log: silent,
        deadlineMs: 5_000,
        pollIntervalMs: 10_000,
        interrupted,
        onVerdict,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    events.emit("completed", { jobId: "system.smoke/1" });
    signal("SIGINT");
    await done;

    expect(
      lines.filter((line) => line.level !== "debug" && line.level !== "trace"),
    ).toEqual([
      expect.objectContaining({ level: "info", msg: "smoke job completed" }),
    ]);
    expect(stops).toEqual([
      ["SIGINT", false],
      ["smoke done", false],
    ]);
  });
});
