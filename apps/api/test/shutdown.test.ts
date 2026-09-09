import { describe, expect, it } from "vitest";
import {
  type ShutdownLogger,
  createShutdownHandler,
} from "../src/lib/shutdown.js";

/** Records what it was told to close, in order. */
function recorder(): { closed: string[]; log: ShutdownLogger } {
  return {
    closed: [],
    log: { info: () => {}, error: () => {} },
  };
}

function targets(closed: string[], failing?: string) {
  const target = (name: string) => ({
    close: async (): Promise<void> => {
      closed.push(name);
      if (name === failing) {
        throw new Error(`${name} refused to close`);
      }
    },
  });
  return { app: target("app"), db: target("db"), redis: target("redis") };
}

describe("createShutdownHandler", () => {
  it("closes the server first, then the connections", async () => {
    const { closed, log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      ...targets(closed),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["app", "db", "redis"]);
    expect(codes).toEqual([0]);
  });

  it("ignores a repeated signal instead of closing twice", async () => {
    const { closed, log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      ...targets(closed),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    // A second pass would call quit() on a client that is already gone and
    // turn a clean stop into an error.
    expect(closed).toEqual(["app", "db", "redis"]);
    expect(codes).toEqual([0]);
  });

  it("finishes the sequence and fails the exit code when a close throws", async () => {
    const { closed, log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      ...targets(closed, "db"),
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["app", "db", "redis"]);
    expect(codes).toEqual([1]);
  });

  it("keeps the timeout verdict when a slow close finishes afterwards", async () => {
    // The real case behind the deadline: a socket that is merely slow, not
    // stuck. The timer has already declared the stop failed, and the loop must
    // not overwrite that with a success once the close comes back - the
    // orchestrator reads the exit code of a process, not the last one it meant.
    const { log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      app: {
        close: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
      },
      db: { close: async () => {} },
      redis: { close: async () => {} },
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(codes).toEqual([1]);
  });

  it("exits on its own when a close never finishes", async () => {
    const { log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      app: { close: () => new Promise<void>(() => {}) },
      db: { close: async () => {} },
      redis: { close: async () => {} },
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(codes).toEqual([1]);
  });
});
