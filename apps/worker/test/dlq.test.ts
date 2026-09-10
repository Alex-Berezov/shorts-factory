import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  type FailedJob,
  createDlqWriter,
  createFailedHandler,
  isFinalFailure,
  toDlqRecord,
} from "../src/lib/dlq.js";
import {
  type LoggedLine,
  type Recorder,
  recordingLogger,
  silentLogger,
} from "./recording-logger.js";

function failedJob(overrides: Partial<FailedJob> = {}): FailedJob {
  return {
    id: "radar.score/abc/24h",
    name: "radar.score",
    data: { videoId: "abc" },
    opts: { attempts: 5 },
    attemptsMade: 5,
    timestamp: 1_773_000_000_000,
    failedReason: "quota exhausted",
    stacktrace: ["Error: quota exhausted"],
    ...overrides,
  };
}

/** A `system.dlq` that records what it was asked to store. */
function fakeDlq() {
  return { add: vi.fn(async () => ({ id: "1" })) };
}

const silent = silentLogger();

/** The lines of one level, for a failure that is swallowed on purpose. */
function errorsOf(recorder: Recorder): LoggedLine[] {
  return recorder.lines.filter((line) => line.level === "error");
}

describe("isFinalFailure", () => {
  it("says no while attempts are left", () => {
    // Without this the same job would be copied into the dlq after every
    // attempt - four records for a job that then succeeds.
    expect(
      isFinalFailure(failedJob({ attemptsMade: 2 }), new Error("boom")),
    ).toBe(false);
  });

  it("says yes when the attempts are spent", () => {
    expect(
      isFinalFailure(failedJob({ attemptsMade: 5 }), new Error("boom")),
    ).toBe(true);
  });

  it("says yes for an unrecoverable error with attempts to spare", () => {
    // BullMQ stops retrying at once, so the count alone would miss it.
    expect(
      isFinalFailure(
        failedJob({ attemptsMade: 1 }),
        new UnrecoverableError("payload does not parse"),
      ),
    ).toBe(true);
  });

  it("treats a job added without attempts as a single run", () => {
    expect(
      isFinalFailure(
        failedJob({ attemptsMade: 1, opts: {} }),
        new Error("boom"),
      ),
    ).toBe(true);
  });
});

describe("toDlqRecord", () => {
  it("keeps the queue, the id and the reason as fields", () => {
    // E13-02 reads these fields; the id of the record is not parsed back.
    const record = toDlqRecord(
      "radar.score",
      failedJob(),
      new Error("boom"),
      new Date("2026-09-10T10:00:00.000Z"),
    );

    expect(record).toEqual({
      queue: "radar.score",
      jobId: "radar.score/abc/24h",
      name: "radar.score",
      data: { videoId: "abc" },
      failedReason: "quota exhausted",
      stacktrace: ["Error: quota exhausted"],
      attemptsMade: 5,
      failedAt: "2026-09-10T10:00:00.000Z",
    });
  });

  it("falls back to the error when the job carries no reason", () => {
    const record = toDlqRecord(
      "radar.score",
      failedJob({ failedReason: undefined, stacktrace: null }),
      new Error("boom"),
      new Date(0),
    );

    expect(record.failedReason).toBe("boom");
    expect(record.stacktrace).toEqual([]);
  });
});

describe("createFailedHandler", () => {
  it("copies a final failure with a deterministic id", async () => {
    const dlq = fakeDlq();
    const onFailed = createFailedHandler({
      queue: "radar.score",
      dlq,
      log: silent,
      now: () => new Date("2026-09-10T10:00:00.000Z"),
    });

    await onFailed(failedJob(), new Error("boom"));

    expect(dlq.add).toHaveBeenCalledTimes(1);
    expect(dlq.add).toHaveBeenCalledWith(
      "system.dlq",
      expect.objectContaining({
        queue: "radar.score",
        jobId: "radar.score/abc/24h",
        attemptsMade: 5,
      }),
      {
        attempts: 1,
        removeOnFail: false,
        // A second `failed` for the same instance - a worker restarted while
        // the job was dying - must leave one record, not two.
        jobId: "dlq/radar.score/radar.score/abc/24h/1773000000000",
      },
    );
  });

  it("leaves a job that will be retried alone", async () => {
    const dlq = fakeDlq();
    const onFailed = createFailedHandler({
      queue: "radar.score",
      dlq,
      log: silent,
    });

    await onFailed(failedJob({ attemptsMade: 1 }), new Error("boom"));

    expect(dlq.add).toHaveBeenCalledTimes(0);
  });

  it("survives a failure whose job record is already gone", async () => {
    const dlq = fakeDlq();
    const onFailed = createFailedHandler({
      queue: "radar.score",
      dlq,
      log: silent,
    });

    await expect(
      onFailed(undefined, new Error("boom")),
    ).resolves.toBeUndefined();
    expect(dlq.add).toHaveBeenCalledTimes(0);
  });

  it("logs a refused dlq write instead of throwing it into the event loop", async () => {
    // The listener is asynchronous: a rejection nobody catches is an unhandled
    // rejection, and Node 22 ends the process over it - together with every
    // job this worker is running.
    const dlq = {
      add: vi.fn(async () => {
        throw new Error("redis is down");
      }),
    };
    const recorder = recordingLogger();
    const onFailed = createFailedHandler({
      queue: "radar.score",
      dlq,
      log: recorder.log,
    });

    await expect(
      onFailed(failedJob(), new Error("boom")),
    ).resolves.toBeUndefined();
    expect(errorsOf(recorder)).toHaveLength(1);
  });
});

describe("createDlqWriter", () => {
  /** A `system.dlq` whose write finishes only when the test says so. */
  function heldDlq() {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const add = vi.fn(async () => {
      await held;
      return { id: "1" };
    });
    return { add, release: (): void => release() };
  }

  it("waits for a copy that is still on its way to redis", async () => {
    // The event is asynchronous and `worker.close()` waits for the handlers of
    // jobs, not for the listeners of events. Without this the shutdown closes
    // the queues and the connection while the copy is in flight, and the
    // record E13-02 exists to show is lost - into the `catch` of the writer.
    const dlq = heldDlq();
    const writer = createDlqWriter({ queue: "radar.score", dlq, log: silent });
    let drained = false;

    writer.onFailed(failedJob(), new Error("boom"));
    const draining = writer.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(dlq.add).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    dlq.release();
    await draining;
    expect(drained).toBe(true);
  });

  it("returns at once when nothing is in flight", async () => {
    const dlq = fakeDlq();
    const writer = createDlqWriter({ queue: "radar.score", dlq, log: silent });

    await expect(writer.drain()).resolves.toBeUndefined();

    writer.onFailed(failedJob({ attemptsMade: 1 }), new Error("boom"));
    await writer.drain();
    expect(dlq.add).toHaveBeenCalledTimes(0);
  });

  it("does not let a refused copy reject the drain", async () => {
    // A stop during a Redis outage still has to finish; the failure is logged
    // by the handler underneath and the shutdown carries on.
    const recorder = recordingLogger();
    const dlq = {
      add: vi.fn(async () => {
        throw new Error("redis is down");
      }),
    };
    const writer = createDlqWriter({
      queue: "radar.score",
      dlq,
      log: recorder.log,
    });

    writer.onFailed(failedJob(), new Error("boom"));

    await expect(writer.drain()).resolves.toBeUndefined();
    expect(errorsOf(recorder)).toHaveLength(1);
  });
});
