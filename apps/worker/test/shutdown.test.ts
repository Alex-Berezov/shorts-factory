import { describe, expect, it } from "vitest";
import {
  type ShutdownStage,
  createShutdownHandler,
} from "../src/lib/shutdown.js";
import { silentLogger } from "./recording-logger.js";

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

describe("createShutdownHandler", () => {
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

  it("ignores a repeated signal instead of closing twice", async () => {
    // Ctrl+C pressed twice, or SIGTERM followed by SIGINT from an orchestrator.
    const closed: string[] = [];
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      stages: stages(closed),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(closed).toEqual(["workers", "queues", "redis", "db"]);
    expect(codes).toEqual([0]);
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
      stages: [{ name: "workers", close: () => new Promise<void>(() => {}) }],
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));

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

    await shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The orchestrator reads the exit code of a process, not the last one it
    // meant: a close that finishes late must not overwrite the timeout.
    expect(codes).toEqual([1]);
  });
});
