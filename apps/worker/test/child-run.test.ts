import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectOutput, endOf, startOf } from "./child-run.js";

/** A child whose events and output a case sends in the order it chooses. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

/** Lets the stream deliver what was written to its `data` listeners. */
function delivered(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
    });
    started.catch(() => undefined);
    child.stdout.write("still loading");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(started).rejects.toThrow(
      "the worker never started; it said: still loading",
    );
  });

  it("drops its deadline once the child says it started", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const started = startOf(child, collectOutput(child), {
      deadlineMs: 1_000,
      tailChars: 2_000,
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
    });
    started.catch(() => undefined);

    await diesWithLateReason(child);

    await expect(started).rejects.toThrow(/it said: reason$/);
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
      startOf(child, output, { deadlineMs: 10_000, tailChars: 2_000 }),
    ).resolves.toBeUndefined();
    await expect(ended).resolves.toMatchObject({ code: 0, signal: null });
  });
});
