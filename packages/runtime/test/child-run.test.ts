import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KILL_DEADLINE_MS,
  collectOutput,
  endOf,
  endWithin,
  freePort,
  killed,
  signalled,
  startOf,
  stopped,
} from "../test-support/child-run.js";

/** A child whose events and output a case sends in the order it chooses. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

/**
 * A child that can be told to stop: it ends on the signals it answers and
 * ignores the rest - every signal (`"all"`), none, or only some. It has no
 * IPC channel unless a case opens one (`connected`).
 */
class StoppableFakeChild extends FakeChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = false;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly answers: "all" | readonly NodeJS.Signals[]) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    const sent = signal ?? "SIGTERM";
    this.signals.push(sent);
    if (this.answers === "all" || this.answers.includes(sent)) {
      this.signalCode = sent;
      this.emit("close", null, this.signalCode);
    }
    return true;
  }
}

/**
 * A child spoken to over IPC whose channel refuses a send with the error the
 * case gives it (`refusal`), or takes it (`null`). The refusal goes where
 * Node sends it: to the callback of the send when there is one, to the
 * `error` of the child otherwise.
 */
class MessagingFakeChild extends EventEmitter {
  connected = true;
  readonly sent: string[] = [];

  constructor(private readonly refusal: Error | null) {
    super();
  }

  send(message: string, callback?: (err: Error | null) => void): boolean {
    this.sent.push(message);
    const refusal = this.refusal;
    if (callback !== undefined) {
      process.nextTick(callback, refusal);
    } else if (refusal !== null) {
      process.nextTick(() => this.emit("error", refusal));
    }
    return refusal === null;
  }
}

/** A refusal of a send, with the code Node gives it. */
function refusalWith(code: string): Error {
  return Object.assign(new Error(`send refused: ${code}`), { code });
}

/** Lets the stream deliver what was written to its `data` listeners. */
function delivered(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Brings the child to the state of one that has closed: `end` marks how it
 * ended, the pipes are closed and `close` has been emitted.
 */
async function closedAfter(
  child: StoppableFakeChild,
  end: () => void,
): Promise<void> {
  end();
  child.stdout.destroy();
  child.stderr.destroy();
  await delivered();
  child.emit("close", child.exitCode, child.signalCode);
}

/**
 * The order a dying worker's last line can take: the process has exited, its
 * reason is still in the pipe, and only then are the pipes closed.
 */
async function diesWithLateReason(child: FakeChild): Promise<void> {
  child.emit("exit", 1, null);
  await delivered();
  child.stderr.write("the late reason");
  await delivered();
  child.emit("close", 1, null);
}

describe("endOf", () => {
  it("ends with what the child said after it exited, before its pipes closed", async () => {
    const child = new FakeChild();
    const ended = endOf(child, collectOutput(child));

    await diesWithLateReason(child);

    await expect(ended).resolves.toEqual({
      code: 1,
      signal: null,
      output: "the late reason",
    });
  });

  it("rejects with the error of a child that could not be started", async () => {
    const child = new FakeChild();
    const ended = endOf(child, collectOutput(child));
    const refusal = new Error("spawn ENOENT");

    child.emit("error", refusal);

    await expect(ended).rejects.toBe(refusal);
  });

  it("lets a child fail before its end is awaited without an unhandled rejection, and still rejects the one who awaits it", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const child = new FakeChild();
      const ended = endOf(child, collectOutput(child));
      const refusal = new Error("spawn ENOENT");

      child.emit("error", refusal);
      await delivered();

      expect(unhandled).toEqual([]);
      await expect(ended).rejects.toBe(refusal);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("collectOutput", () => {
  it("keeps only the streams it is told to read", async () => {
    const child = new FakeChild();
    const output = collectOutput(child, ["stdout"]);

    child.stderr.write("a warning");
    child.stdout.write("the verdict");
    await delivered();

    expect(output()).toBe("the verdict");
  });
});

describe("startOf", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails with what the child said once the deadline passes without a start", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const output = collectOutput(child);
    const started = startOf(child, output, {
      deadlineMs: 1_000,
      tailChars: 2_000,
      name: "the worker",
    });
    started.catch(() => undefined);
    child.stdout.write("still loading");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(started).rejects.toThrow(
      "the worker never started; it said: still loading",
    );
  });

  it("quotes only the tail of what the child said when the deadline passes", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 1_000,
      tailChars: 7,
      name: "the worker",
    });
    started.catch(() => undefined);
    child.stdout.write("a long story, then loading");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(started).rejects.toThrow(
      /^the worker never started; it said: loading$/,
    );
  });

  it("names the child it is given in every failure, not the worker", async () => {
    vi.useFakeTimers();
    const limits = { deadlineMs: 1_000, tailChars: 2_000, name: "the api" };
    const silent = new FakeChild();
    const byDeadline = startOf(silent, collectOutput(silent), limits);
    byDeadline.catch(() => undefined);
    const dying = new FakeChild();
    const byEnd = startOf(dying, collectOutput(dying), limits);
    byEnd.catch(() => undefined);
    const broken = new FakeChild();
    const byError = startOf(broken, collectOutput(broken), limits);
    byError.catch(() => undefined);

    dying.emit("close", 1, null);
    broken.emit("error", new Error("spawn ENOENT"));
    await vi.advanceTimersByTimeAsync(1_000);

    for (const failed of [byDeadline, byEnd, byError]) {
      const reason: unknown = await failed.catch((err: unknown) => err);
      expect(reason).toBeInstanceOf(Error);
      const message = reason instanceof Error ? reason.message : "";
      expect(message).toMatch(/^the api /);
      expect(message).not.toContain("the worker");
    }
  });

  it("drops its deadline once the child says it started", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 1_000,
      tailChars: 2_000,
      name: "the worker",
    });

    child.emit("message", "started");

    await expect(started).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops its deadline once the child ends on its way up", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 1_000,
      tailChars: 2_000,
      name: "the worker",
    });
    started.catch(() => undefined);

    child.emit("close", 1, null);

    await expect(started).rejects.toThrow(
      "the worker exited before it started",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails at once, with the error as the cause, when the child cannot be started", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 1_000,
      tailChars: 2_000,
      name: "the worker",
    });
    started.catch(() => undefined);
    const refusal = new Error("spawn ENOENT");

    child.emit("error", refusal);

    await expect(started).rejects.toMatchObject({
      message: "the worker could not be started: spawn ENOENT",
      cause: refusal,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with the code and the last thing the child said when it dies on its way up", async () => {
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 10_000,
      tailChars: 2_000,
      name: "the worker",
    });
    started.catch(() => undefined);

    await diesWithLateReason(child);

    await expect(started).rejects.toThrow(
      "the worker exited before it started (code 1, signal null); it said: the late reason",
    );
  });

  it("keeps only the tail of what the child said", async () => {
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 10_000,
      tailChars: 6,
      name: "the worker",
    });
    started.catch(() => undefined);

    await diesWithLateReason(child);

    await expect(started).rejects.toThrow(/it said: reason$/);
  });
});

describe("stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the signal and is done once the child closes", async () => {
    const child = new StoppableFakeChild("all");

    await stopped(child, { deadlineMs: 1_000, name: "the api" });

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("sends the signal it is given", async () => {
    const child = new StoppableFakeChild("all");

    await stopped(child, {
      deadlineMs: 1_000,
      name: "the api",
      signal: "SIGKILL",
    });

    expect(child.signals).toEqual(["SIGKILL"]);
  });

  it("leaves a child that has already closed be", async () => {
    const child = new StoppableFakeChild("all");
    await closedAfter(child, () => {
      child.exitCode = 0;
    });

    await stopped(child, { deadlineMs: 1_000, name: "the api" });

    expect(child.signals).toEqual([]);
  });

  it("leaves a child that has already closed after a signal be", async () => {
    const child = new StoppableFakeChild("all");
    await closedAfter(child, () => {
      child.signalCode = "SIGTERM";
    });

    await stopped(child, { deadlineMs: 1_000, name: "the api" });

    expect(child.signals).toEqual([]);
  });

  it("waits for the close of a child that has ended with its pipes closed and its IPC channel still open", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild("all");
    child.exitCode = 0;
    child.connected = true;
    child.stdout.destroy();
    child.stderr.destroy();
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const stop = stopped(child, { deadlineMs: 1_000, name: "the api" }).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    child.connected = false;
    child.emit("close", 0, null);

    await stop;
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the close of a child that has ended by a signal, and sends it nothing", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild("all");
    child.signalCode = "SIGTERM";
    let settled = false;
    const stop = stopped(child, { deadlineMs: 1_000, name: "the api" }).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");

    await stop;
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the close of a child that has ended, and sends it nothing", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild("all");
    child.exitCode = 0;
    let settled = false;
    const stop = stopped(child, { deadlineMs: 1_000, name: "the api" }).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    child.emit("close", 0, null);

    await stop;
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails, naming the child, once a child that has ended does not close within the deadline", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild("all");
    child.exitCode = 0;
    const verdict = expect(
      stopped(child, { deadlineMs: 1_000, name: "the api" }),
    ).rejects.toThrow(
      /^the close of the api, which had ended: no answer within 1000 ms$/,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await verdict;
    expect(child.signals).toEqual([]);
  });

  it("fails at the deadline of a stop by SIGKILL, with no second kill and no second wait", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild([]);
    const verdict = expect(
      stopped(child, { deadlineMs: 1_000, name: "the api", signal: "SIGKILL" }),
    ).rejects.toThrow(
      /^the stop of the api by SIGKILL: no answer within 1000 ms$/,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await verdict;
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a child that ignores the signal past the deadline, and still fails naming the missed stop", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild(["SIGKILL"]);
    const stop = stopped(child, { deadlineMs: 1_000, name: "the api" });
    const verdict = expect(stop).rejects.toThrow(
      /^the stop of the api by SIGTERM: no answer within 1000 ms$/,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await verdict;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with the missed stop, not the kill, once even the kill brings no close in its bound", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild([]);
    const stop = stopped(child, { deadlineMs: 1_000, name: "the api" });
    let settled = false;
    const verdict = expect(
      stop.finally(() => {
        settled = true;
      }),
    ).rejects.toThrow(
      /^the stop of the api by SIGTERM: no answer within 1000 ms$/,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS);

    await verdict;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("killed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the child and waits for its close", async () => {
    const child = new StoppableFakeChild(["SIGKILL"]);

    await killed(child, "the worker");

    expect(child.signals).toEqual(["SIGKILL"]);
  });

  it("drops its own failure once even the kill brings no close in its bound", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild([]);
    let settled = false;
    const kill = killed(child, "the worker").then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(kill).resolves.toBeUndefined();
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("endWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the end of a child that ends in time", async () => {
    const child = new StoppableFakeChild("all");
    const ended = endOf(child, collectOutput(child));
    child.emit("close", 0, null);

    await expect(endWithin(child, ended, 1_000, "the worker")).resolves.toEqual(
      { code: 0, signal: null, output: "" },
    );
    expect(child.signals).toEqual([]);
  });

  it("kills a child that misses its end, then fails with the miss", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild(["SIGKILL"]);
    const verdict = expect(
      endWithin(child, endOf(child, collectOutput(child)), 1_000, "the worker"),
    ).rejects.toThrow(/^the end of the worker: no answer within 1000 ms$/);

    await vi.advanceTimersByTimeAsync(1_000);

    await verdict;
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails at once with the error of a child that could not be started, and sends it nothing", async () => {
    vi.useFakeTimers();
    const child = new StoppableFakeChild("all");
    const ended = endOf(child, collectOutput(child));
    const refusal = new Error("spawn ENOENT");
    const verdict = expect(
      endWithin(child, ended, 1_000, "the worker"),
    ).rejects.toBe(refusal);

    child.emit("error", refusal);

    await verdict;
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("signalled", () => {
  it("asks a child with an open channel to raise its signal", async () => {
    const child = new MessagingFakeChild(null);

    await signalled(child);

    expect(child.sent).toEqual(["signal"]);
  });

  it("sends nothing to a child whose channel has closed", async () => {
    const child = new MessagingFakeChild(null);
    child.connected = false;

    await signalled(child);

    expect(child.sent).toEqual([]);
  });

  it("raises no error of the child when the channel refuses the send as it closes", async () => {
    const child = new MessagingFakeChild(refusalWith("EPIPE"));
    const errors: Error[] = [];
    child.on("error", (err: Error) => {
      errors.push(err);
    });

    await signalled(child);
    await delivered();

    expect(child.sent).toEqual(["signal"]);
    expect(errors).toEqual([]);
  });
});

describe("freePort", () => {
  it("gives a port nothing listens on", async () => {
    const port = await freePort();

    expect(port).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    });
  });
});

describe("a real child", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("is let through once it says it started, and ends with its code", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.send("started"); setTimeout(() => process.exit(0), 50);'],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(child);
    const output = collectOutput(child);
    const ended = endOf(child, output);

    await expect(
      startOf(child, output, {
        deadlineMs: 10_000,
        tailChars: 2_000,
        name: "the child",
      }),
    ).resolves.toBeUndefined();
    await expect(ended).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("has closed by the time a stop returns, once it has exited and its pipes have closed", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      throw new Error("the child was started without its pipes");
    }
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    // Exited, and its pipes closed: where its IPC channel has not ended yet
    // - the order of these events is the platform's - Node has not emitted
    // `close`, and the stop has to wait for it.
    await Promise.all([
      once(child, "exit"),
      once(stdout, "close"),
      once(stderr, "close"),
    ]);

    await stopped(child, { deadlineMs: 2_000, name: "the child" });

    expect(closed).toBe(true);
  });

  it("is left be by a stop once it has closed, without a wait for a close that has been", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    await endOf(child, collectOutput(child));
    // Monotonic: a step of the wall clock is no time the stop took.
    const startedAt = performance.now();

    await stopped(child, { deadlineMs: 2_000, name: "the child" });

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
