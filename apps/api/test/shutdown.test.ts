import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ShutdownLogger,
  createShutdownHandler,
} from "../src/lib/shutdown.js";

// The deadline of the stop is a timer; the cases that are about it move the
// clock instead of waiting on it.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** One line of the shutdown log, as the handler wrote it. */
interface Line {
  level: "info" | "warn" | "error";
  obj: object;
  msg: string;
}

/** Records what it was told to close, in order, and what it logged. */
function recorder(): { closed: string[]; lines: Line[]; log: ShutdownLogger } {
  const lines: Line[] = [];
  return {
    closed: [],
    lines,
    log: {
      info: (obj, msg) => lines.push({ level: "info", obj, msg }),
      warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
      error: (obj, msg) => lines.push({ level: "error", obj, msg }),
    },
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
  return {
    app: target("app"),
    db: target("db"),
    queues: target("queues"),
    redis: target("redis"),
  };
}

/** The targets whose `closed` line was written, in the order of the lines. */
function closedLines(lines: readonly Line[]): unknown[] {
  return lines
    .filter((line) => line.msg === "closed")
    .map((line) => ("target" in line.obj ? line.obj.target : undefined));
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

    // The two branches after the server run at once, so only the server's
    // place and the order inside the Redis branch are fixed.
    expect(closed[0]).toBe("app");
    expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
    expect(codes).toEqual([0]);
  });

  it("closes the queues before the Redis client they run on", async () => {
    const { closed, log } = recorder();
    const shutdown = createShutdownHandler({
      ...targets(closed),
      log,
      exit: () => {},
    });

    await shutdown("SIGTERM");

    expect(closed.indexOf("queues")).toBeLessThan(closed.indexOf("redis"));
  });

  /**
   * A database whose close never finishes must not hold Redis open: run in a
   * line, the client would stay connected until the deadline killed the
   * process, with no `closed` line for it in the log of the stop.
   */
  it("closes Redis while the database is still closing", async () => {
    const { closed, lines, log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      ...targets(closed),
      db: { close: () => new Promise<void>(() => {}) },
      log,
      timeoutMs: 50,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);

    expect(closed).toEqual(["app", "queues", "redis"]);
    expect(closedLines(lines)).toEqual(["app", "queues", "redis"]);
    // The database never closed: the deadline is the verdict.
    expect(codes).toEqual([1]);
  });

  /**
   * A target that closed, but not the clean way - the Redis client torn down
   * after a refused QUIT (`compose-app.ts`): the stop is clean, but the log
   * must not claim the clean way that never happened.
   */
  it("writes the warning a target closed with and still exits 0", async () => {
    const { closed, lines, log } = recorder();
    const codes: number[] = [];
    const refusal = new Error(
      "Stream isn't writeable and enableOfflineQueue options is false",
    );
    const shutdown = createShutdownHandler({
      ...targets(closed),
      redis: {
        close: async () => ({ warning: "closed by disconnect", err: refusal }),
      },
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(lines.filter((line) => line.level === "warn")).toEqual([
      {
        level: "warn",
        obj: { signal: "SIGTERM", target: "redis", err: refusal },
        msg: "closed by disconnect",
      },
    ]);
    expect(closedLines(lines)).not.toContain("redis");
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
    expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
    expect(codes).toEqual([0]);
  });

  /**
   * Whichever target refused - the server, the driver, or either half of the
   * Redis branch - the others are still closed, and the exit code says the
   * stop did not close what it claimed to.
   */
  it.each(["app", "db", "queues", "redis"])(
    "finishes the sequence and fails the exit code when %s refuses to close",
    async (failing) => {
      const { closed, lines, log } = recorder();
      const codes: number[] = [];
      const shutdown = createShutdownHandler({
        ...targets(closed, failing),
        log,
        exit: (code) => codes.push(code),
      });

      await shutdown("SIGTERM");

      expect([...closed].sort()).toEqual(["app", "db", "queues", "redis"]);
      expect(
        lines
          .filter((line) => line.msg === "close failed")
          .map((line) => ("target" in line.obj ? line.obj.target : undefined)),
      ).toEqual([failing]);
      expect(codes).toEqual([1]);
    },
  );

  /**
   * A failed close of the queues is no reason to leave the client they ran
   * on open: Redis is still closed, and its line says so.
   */
  it("closes Redis after the queues refused to close", async () => {
    const { closed, lines, log } = recorder();
    const shutdown = createShutdownHandler({
      ...targets(closed, "queues"),
      log,
      exit: () => {},
    });

    await shutdown("SIGTERM");

    expect(closed.indexOf("queues")).toBeLessThan(closed.indexOf("redis"));
    expect(closedLines(lines)).toContain("redis");
  });

  /**
   * A close is typed `void` and may still resolve with a value of its own;
   * only an answer shaped as a warning is one. Anything else read as a
   * warning would be a `warn` line with no message in a clean stop.
   */
  it("calls a close that resolved with something other than a warning closed", async () => {
    const { closed, lines, log } = recorder();
    const codes: number[] = [];
    // What a `() => void` callback is allowed to do in TypeScript: return a
    // value its type says nothing about.
    const instance: () => void = () => ({ closed: true });
    const count: () => void = () => 3;
    const shutdown = createShutdownHandler({
      ...targets(closed),
      app: { close: async () => instance() },
      db: { close: async () => count() },
      log,
      exit: (code) => codes.push(code),
    });

    await shutdown("SIGTERM");

    expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    expect(closedLines(lines)).toEqual(
      expect.arrayContaining(["app", "db", "queues", "redis"]),
    );
    expect(codes).toEqual([0]);
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
      queues: { close: async () => {} },
      redis: { close: async () => {} },
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    const stopped = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(40);
    await stopped;

    expect(codes).toEqual([1]);
  });

  it("exits on its own when a close never finishes", async () => {
    const { log } = recorder();
    const codes: number[] = [];
    const shutdown = createShutdownHandler({
      app: { close: () => new Promise<void>(() => {}) },
      db: { close: async () => {} },
      queues: { close: async () => {} },
      redis: { close: async () => {} },
      log,
      timeoutMs: 20,
      exit: (code) => codes.push(code),
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(20);

    expect(codes).toEqual([1]);
  });
});
